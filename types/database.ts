export type Database = {
  public: {
    Tables: {
      restaurants: { Row: { id:string; name:string; slug:string; phone:string|null; email:string|null; website_url:string|null; logo_url:string|null; timezone:string; max_online_party_size:number; created_at:string; updated_at:string }; Insert: Partial<Database["public"]["Tables"]["restaurants"]["Row"]>; Update: Partial<Database["public"]["Tables"]["restaurants"]["Row"]> };
      restaurant_locations: { Row: { id:string; restaurant_id:string; name:string; address_line1:string; city:string; province:string; postal_code:string|null; phone:string|null; email:string|null; is_active:boolean; created_at:string }; Insert: Partial<Database["public"]["Tables"]["restaurant_locations"]["Row"]>; Update: Partial<Database["public"]["Tables"]["restaurant_locations"]["Row"]> };
      restaurant_hours: { Row: { id:string; location_id:string; day_of_week:number; opens_at:string|null; closes_at:string|null; is_closed:boolean; created_at:string }; Insert: Partial<Database["public"]["Tables"]["restaurant_hours"]["Row"]>; Update: Partial<Database["public"]["Tables"]["restaurant_hours"]["Row"]> };
      menu_categories: { Row: { id:string; restaurant_id:string; name:string; display_order:number; is_active:boolean }; Insert: Partial<Database["public"]["Tables"]["menu_categories"]["Row"]>; Update: Partial<Database["public"]["Tables"]["menu_categories"]["Row"]> };
      menu_items: { Row: { id:string; category_id:string; name:string; description:string|null; price:number|string; dietary_tags:string[]; is_available:boolean; display_order:number; image_url:string|null; created_at:string; updated_at:string }; Insert: Partial<Database["public"]["Tables"]["menu_items"]["Row"]>; Update: Partial<Database["public"]["Tables"]["menu_items"]["Row"]> };
      orders: { Row: { id:string; order_number:number; restaurant_id:string; location_id:string; customer_name:string; customer_phone:string; fulfillment_type:string; status:string; notes:string|null; subtotal:number|string; tax:number|string; total:number|string; requested_at:string; confirmed_at:string|null; completed_at:string|null; created_at:string; updated_at:string }; Insert: Partial<Database["public"]["Tables"]["orders"]["Row"]>; Update: Partial<Database["public"]["Tables"]["orders"]["Row"]> };
      order_items: { Row: { id:string; order_id:string; menu_item_id:string|null; item_name:string; unit_price:number|string; quantity:number; line_total:number|string; special_instructions:string|null }; Insert: Partial<Database["public"]["Tables"]["order_items"]["Row"]>; Update: Partial<Database["public"]["Tables"]["order_items"]["Row"]> };
      reservations: { Row: { id:string; reservation_number:number; restaurant_id:string; location_id:string; customer_name:string; customer_phone:string; party_size:number; requested_date:string; requested_time:string; status:string; proposed_date:string|null; proposed_time:string|null; customer_notes:string|null; staff_notes:string|null; source:string; requested_at:string; confirmed_at:string|null; completed_at:string|null; created_at:string; updated_at:string }; Insert: Partial<Database["public"]["Tables"]["reservations"]["Row"]>; Update: Partial<Database["public"]["Tables"]["reservations"]["Row"]> };
      reservation_events: { Row: { id:string; reservation_id:string; from_status:string|null; to_status:string; actor_type:string; actor_id:string|null; note:string|null; created_at:string }; Insert: Partial<Database["public"]["Tables"]["reservation_events"]["Row"]>; Update: Partial<Database["public"]["Tables"]["reservation_events"]["Row"]> };
      ai_agents: { Row: { id:string; restaurant_id:string; location_id:string|null; retell_agent_id:string|null; name:string; language:string; status:string; configuration:Record<string, unknown>; created_at:string; updated_at:string }; Insert: Partial<Database["public"]["Tables"]["ai_agents"]["Row"]>; Update: Partial<Database["public"]["Tables"]["ai_agents"]["Row"]> };
    };
    Views: Record<string, never>;
    Functions: {
      create_order_atomic: { Args: { p_restaurant_id:string; p_location_id:string; p_customer_name:string; p_customer_phone:string; p_fulfillment_type:string; p_notes:string|null; p_items:unknown[] }; Returns: Record<string, unknown> };
      create_reservation_atomic: { Args: { p_restaurant_id:string; p_location_id:string; p_customer_name:string; p_customer_phone:string; p_party_size:number; p_requested_date:string; p_requested_time:string; p_customer_notes:string|null; p_source:string }; Returns: Record<string, unknown> };
      update_reservation_status: { Args: { p_reservation_id:string; p_status:string; p_actor_type:string; p_note:string|null }; Returns: Record<string, unknown> };
      propose_reservation_time: { Args: { p_reservation_id:string; p_proposed_date:string; p_proposed_time:string; p_note:string|null }; Returns: Record<string, unknown> };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};
