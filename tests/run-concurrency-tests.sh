#!/usr/bin/env bash
set -euo pipefail
: "${TEST_DATABASE_URL:?TEST_DATABASE_URL is required}"

R="11111111-1111-1111-1111-111111111111"
L="22222222-2222-2222-2222-222222222222"
A="44444444-4444-4444-4444-444444444444"

psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 <<SQL
insert into public.ai_working_orders(call_id,agent_id,restaurant_id,location_id,items)
values('parallel-update','$A','$R','$L','[{"line_id":"race","item_name":"Coke","quantity":1,"ready":true}]');
insert into public.ai_working_orders(call_id,agent_id,restaurant_id,location_id,items)
values('parallel-create','$A','$R','$L','[{"line_id":"create","item_name":"Coke","quantity":1,"ready":true}]');
SQL

TOKEN="$(psql "$TEST_DATABASE_URL" -Atqc "select guarded_quote('$R','$L','$A','parallel-create',0)")"

set +e
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -c "select mutate_line('$R','$L','$A','parallel-update',0,'race','{\"quantity\":2}'::jsonb)" >/tmp/update1.log 2>&1 &
U1=$!
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -c "select mutate_line('$R','$L','$A','parallel-update',0,'race','{\"quantity\":3}'::jsonb)" >/tmp/update2.log 2>&1 &
U2=$!
wait "$U1"; S1=$?
wait "$U2"; S2=$?
set -e

if [[ $(( (S1==0) + (S2==0) )) -ne 1 ]]; then
  echo "Expected exactly one concurrent update to succeed; statuses: $S1 $S2"
  cat /tmp/update1.log /tmp/update2.log
  exit 1
fi
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -c "select assert_true(revision=1 and (items->0->>'quantity')::int in (2,3),'parallel update has one winner and no silent overwrite') from public.ai_working_orders where call_id='parallel-update';"

set +e
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -c "select guarded_create('$R','$L','$A','parallel-create',0,'$TOKEN')" >/tmp/create1.log 2>&1 &
C1=$!
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -c "select guarded_create('$R','$L','$A','parallel-create',0,'$TOKEN')" >/tmp/create2.log 2>&1 &
C2=$!
wait "$C1"; C1S=$?
wait "$C2"; C2S=$?
set -e

if [[ $(( (C1S==0) + (C2S==0) )) -ne 1 ]]; then
  echo "Expected exactly one concurrent create to succeed; statuses: $C1S $C2S"
  cat /tmp/create1.log /tmp/create2.log
  exit 1
fi
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -c "select assert_true((select count(*) from created_order_test where restaurant_id='$R' and location_id='$L' and call_id='parallel-create')=1,'parallel create produces exactly one order');"
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -c "select assert_true((select status from public.ai_working_orders where call_id='parallel-create' and restaurant_id='$R' and location_id='$L')='created','parallel create finalizes one state');"

echo "PARALLEL_CONCURRENCY_PASS"
