import { createServerSupabase } from "@/lib/supabase/server";

type Agent = {
  id: string;
  name: string;
  status: string;
  retell_agent_id: string | null;
  language: string | null;
  configuration: unknown;
  updated_at: string;
};

export default async function AiReceptionistPage() {
  const supabase = createServerSupabase();
  const { data } = await supabase
    .from("ai_agents")
    .select("id,name,status,retell_agent_id,language,configuration,updated_at")
    .order("updated_at", { ascending: false });

  const agents = (data ?? []) as Agent[];

  return (
    <div>
      <div className="mb-8">
        <p className="text-sm font-medium text-slate-500">AI Receptionist</p>
        <h1 className="mt-1 text-3xl font-bold">Phone AI</h1>
        <p className="mt-2 text-slate-500">
          Retell-ready agent configuration backed by the existing database.
        </p>
      </div>

      {agents.length ? (
        <div className="grid gap-4 md:grid-cols-2">
          {agents.map((agent) => (
            <div key={agent.id} className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
              <div className="flex justify-between">
                <h2 className="font-semibold">{agent.name}</h2>
                <span className="rounded-full bg-slate-100 px-2 py-1 text-xs">{agent.status}</span>
              </div>
              <dl className="mt-5 space-y-3 text-sm">
                <div className="flex justify-between">
                  <dt className="text-slate-500">Language</dt>
                  <dd>{agent.language ?? "Not configured"}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-500">Retell agent</dt>
                  <dd>{agent.retell_agent_id ?? "Not connected"}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-500">Updated</dt>
                  <dd>{new Date(agent.updated_at).toLocaleString()}</dd>
                </div>
              </dl>
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-12 text-center">
          <h2 className="font-semibold">No AI agent configured</h2>
          <p className="mt-2 text-sm text-slate-500">
            The database currently has no AI agents. Retell credentials will be added only when the integration is configured.
          </p>
        </div>
      )}
    </div>
  );
}
