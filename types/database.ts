export type Json =
  | string | number | boolean | null
  | { [key: string]: Json | undefined }
  | Json[];

type Table<T> = { Row: T; Insert: Partial<T>; Update: Partial<T>; Relationships: [] };

export type Database = {
  public: {
    Tables: {
      restaurants: Table<{id:string;name:string;slug:string;phone:string|null;email:string|null;website_url:string|null;logo_url:string|null;timezone:string;max_online_party_size:number;created_at:string;updated_at:string}>;
      restaurant_locations: Table<{id:string;restaurant_id:string;name:string;address_line1:string;city:string;province:string;postal_code:string|null;phone:string|null;email:string|null;is_active:boolean;created_at:string}>;
      restaurant_hours: Table<{id:string;location_id:string;day_of_week:number;opens_at:string|null;closes_at:string|null;is_closed:boolean;created_at:string}>;
      menu_categories: Table<{id:string;restaurant_id:string;name:string;display_order:number;is_active:boolean}>;
      menu_items: Table<{id:string;category_id:string;name:string;description:string|null;price:number|string;dietary_tags:string[];is_available:boolean;display_order:number;image_url:string|null;item_type:string;created_at:string;updated_at:string}>;
      menu_item_sizes: Table<{id:string;menu_item_id:string;name:string;price:number;is_available:boolean;display_order:number;created_at:string;updated_at:string}>;
      menu_ingredients: Table<{id:string;restaurant_id:string;name:string;description:string|null;allergens:string[];dietary_tags:string[];is_available:boolean;created_at:string;updated_at:string}>;
      menu_item_ingredients: Table<{id:string;menu_item_id:string;ingredient_id:string;quantity:number|null;unit:string|null;preparation_note:string|null;is_default:boolean;display_order:number}>;
      modifier_groups: Table<{id:string;restaurant_id:string;name:string;description:string|null;selection_type:string;min_selections:number;max_selections:number|null;allow_duplicate_selections:boolean;is_active:boolean;display_order:number;created_at:string;updated_at:string}>;
      modifiers: Table<{id:string;modifier_group_id:string;name:string;description:string|null;price_delta:number;max_quantity:number;is_available:boolean;display_order:number;action:string;target_ingredient_id:string|null;replacement_ingredient_id:string|null;pricing_mode:string;price_multiplier:number;side_pricing_factor:number;created_at:string;updated_at:string}>;
      menu_item_modifier_groups: Table<{id:string;menu_item_id:string;modifier_group_id:string;min_selections:number;max_selections:number|null;required:boolean;free_selections:number;display_order:number}>;
      menu_item_modifier_group_size_rules: Table<{id:string;menu_item_id:string;modifier_group_id:string;menu_item_size_id:string;min_selections:number;max_selections:number|null;required:boolean;free_selections:number}>;
      modifier_price_rules: Table<{id:string;modifier_id:string;menu_item_size_id:string|null;price_delta:number}>;
      modifier_quantity_levels: Table<{id:string;modifier_id:string;name:string;multiplier:number;price_delta_override:number|null;display_order:number}>;
      menu_item_availability_windows: Table<{id:string;menu_item_id:string;day_of_week:number;starts_at:string;ends_at:string}>;
      modifier_availability_windows: Table<{id:string;modifier_id:string;day_of_week:number;starts_at:string;ends_at:string}>;
      combo_groups: Table<{id:string;combo_item_id:string;name:string;min_selections:number;max_selections:number;display_order:number}>;
      combo_group_options: Table<{id:string;combo_group_id:string;menu_item_id:string|null;menu_item_size_id:string|null;modifier_id:string|null;label:string|null;price_delta:number;is_available:boolean;display_order:number}>;
      customers: Table<{id:string;restaurant_id:string;name:string;phone:string;email:string|null;default_address_line1:string|null;default_address_line2:string|null;default_city:string|null;default_province:string|null;default_postal_code:string|null;delivery_instructions:string|null;created_at:string;updated_at:string}>;
      orders: Table<{id:string;order_number:number;restaurant_id:string;location_id:string;customer_id:string|null;customer_name:string;customer_phone:string;fulfillment_type:string;status:string;notes:string|null;subtotal:number|string;tax:number|string;total:number|string;requested_at:string;confirmed_at:string|null;completed_at:string|null;scheduled_for:string|null;delivery_fee:number|string;delivery_address_line1:string|null;delivery_address_line2:string|null;delivery_city:string|null;delivery_province:string|null;delivery_postal_code:string|null;delivery_instructions:string|null;table_number:string|null;created_at:string;updated_at:string}>;
      order_items: Table<{id:string;order_id:string;menu_item_id:string|null;menu_item_size_id:string|null;item_name:string;item_type:string;unit_price:number|string;quantity:number;line_total:number|string;special_instructions:string|null}>;
      order_item_selections: Table<{id:string;order_item_id:string;modifier_id:string|null;target_ingredient_id:string|null;replacement_ingredient_id:string|null;action:string;side:string;quantity:number;selection_name:string;modifier_quantity_level_id:string|null;unit_price_delta:number|string;total_price_delta:number|string;notes:string|null;created_at:string}>;
      reservations: Table<{id:string;reservation_number:number;restaurant_id:string;location_id:string;customer_name:string;customer_phone:string;party_size:number;requested_date:string;requested_time:string;status:string;proposed_date:string|null;proposed_time:string|null;customer_notes:string|null;staff_notes:string|null;source:string;requested_at:string;confirmed_at:string|null;completed_at:string|null;created_at:string;updated_at:string}>;
      reservation_events: Table<{id:string;reservation_id:string;from_status:string|null;to_status:string;actor_type:string;actor_id:string|null;note:string|null;created_at:string}>;
      ai_agents: Table<{id:string;restaurant_id:string;location_id:string|null;retell_agent_id:string|null;name:string;language:string;status:string;configuration:Record<string,unknown>;created_at:string;updated_at:string}>;
    };
    Views: Record<string, never>;
    Functions: {
      create_order_atomic: {Args:{p_restaurant_id:string;p_location_id:string;p_customer_name:string;p_customer_phone:string;p_fulfillment_type:string;p_notes:string|null;p_items:Json};Returns:Json};
      create_complex_order_atomic: {Args:{p_restaurant_id:string;p_location_id:string;p_customer_name:string;p_customer_phone:string;p_fulfillment_type:string;p_notes:string|null;p_scheduled_for:string|null;p_delivery_address_line1:string|null;p_delivery_address_line2:string|null;p_delivery_city:string|null;p_delivery_province:string|null;p_delivery_postal_code:string|null;p_delivery_instructions:string|null;p_table_number:string|null;p_items:Json};Returns:Json};
      create_reservation_atomic: {Args:{p_restaurant_id:string;p_location_id:string;p_customer_name:string;p_customer_phone:string;p_party_size:number;p_requested_date:string;p_requested_time:string;p_customer_notes:string|null;p_source:string};Returns:Json};
      update_reservation_status: {Args:{p_reservation_id:string;p_status:string;p_actor_type:string;p_note:string|null};Returns:Json};
      propose_reservation_time: {Args:{p_reservation_id:string;p_proposed_date:string;p_proposed_time:string;p_note:string|null};Returns:Json};
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};
