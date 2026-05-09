/**
 * @file database.ts
 * @description TypeScript types for the PropOS Supabase database schema.
 * Generated from migrations 00003–00011. Matches the deployed schema exactly.
 * Regenerate when schema changes: node supabase/run_migrations.mjs && supabase gen types typescript
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

/**
 * Snapshot of a proposed transaction stored on `payment_authorisations.proposed`
 * (JSONB) when a payment is awaiting authorisation. On authorise, the
 * application uses this snapshot to insert the actual `transactions` row.
 * Inner shape is application-validated; the DB CHECK constraint only verifies
 * presence (not structure). See migration 00022 + DECISIONS 2026-05-10.
 */
export interface ProposedTransaction {
  bank_account_id:  string
  amount:           number
  transaction_date: string
  description:      string
  payee_payer:      string | null
  reference:        string | null
  demand_id:        string | null
}

export interface Database {
  public: {
    Tables: {
      firms: {
        Row: {
          id: string
          name: string
          slug: string
          subscription_tier: string
          rics_regulated: boolean
          rics_firm_number: string | null
          address_line1: string | null
          address_line2: string | null
          town: string | null
          postcode: string | null
          phone: string | null
          email: string | null
          website: string | null
          logo_storage_path: string | null
          client_money_account_bank: string | null
          deployment_mode: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          name: string
          slug: string
          subscription_tier?: string
          rics_regulated?: boolean
          rics_firm_number?: string | null
          address_line1?: string | null
          address_line2?: string | null
          town?: string | null
          postcode?: string | null
          phone?: string | null
          email?: string | null
          website?: string | null
          logo_storage_path?: string | null
          client_money_account_bank?: string | null
          deployment_mode?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: Partial<Database['public']['Tables']['firms']['Insert']>
        Relationships: []
      }
      users: {
        Row: {
          id: string
          firm_id: string
          full_name: string
          email: string
          role: string
          phone: string | null
          active: boolean
          last_login: string | null
          portal_access: boolean
          created_at: string
          updated_at: string
        }
        Insert: {
          id: string
          firm_id: string
          full_name: string
          email: string
          role?: string
          phone?: string | null
          active?: boolean
          last_login?: string | null
          portal_access?: boolean
          created_at?: string
          updated_at?: string
        }
        Update: Partial<Omit<Database['public']['Tables']['users']['Insert'], 'id'>>
        Relationships: []
      }
      properties: {
        Row: {
          id: string
          firm_id: string
          name: string
          address_line1: string
          address_line2: string | null
          town: string
          postcode: string
          property_type: string
          total_units: number | null
          build_year: number | null
          listed_status: string | null
          freeholder_name: string | null
          freeholder_contact: string | null
          managing_since: string | null
          assigned_pm_id: string | null
          legacy_ref: string | null
          notes: string | null
          is_hrb: boolean
          storey_count: number | null
          height_metres: number | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          firm_id: string
          name: string
          address_line1: string
          address_line2?: string | null
          town: string
          postcode: string
          property_type: string
          total_units?: number | null
          build_year?: number | null
          listed_status?: string | null
          freeholder_name?: string | null
          freeholder_contact?: string | null
          managing_since?: string | null
          assigned_pm_id?: string | null
          legacy_ref?: string | null
          notes?: string | null
          is_hrb?: boolean
          storey_count?: number | null
          height_metres?: number | null
          created_at?: string
          updated_at?: string
        }
        Update: Partial<Omit<Database['public']['Tables']['properties']['Insert'], 'id'>>
        Relationships: []
      }
      units: {
        Row: {
          id: string
          firm_id: string
          property_id: string
          unit_ref: string
          floor: number | null
          unit_type: string
          lease_start: string | null
          lease_end: string | null
          lease_term_years: number | null
          ground_rent_pa: number | null
          ground_rent_review_date: string | null
          ground_rent_review_basis: string | null
          is_share_of_freehold: boolean
          is_currently_let: boolean
          notes: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          firm_id: string
          property_id: string
          unit_ref: string
          floor?: number | null
          unit_type?: string
          lease_start?: string | null
          lease_end?: string | null
          lease_term_years?: number | null
          ground_rent_pa?: number | null
          ground_rent_review_date?: string | null
          ground_rent_review_basis?: string | null
          is_share_of_freehold?: boolean
          is_currently_let?: boolean
          notes?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: Partial<Omit<Database['public']['Tables']['units']['Insert'], 'id'>>
        Relationships: []
      }
      apportionment_schedules: {
        Row: {
          id: string
          firm_id: string
          property_id: string
          schedule_name: string
          method: string
          description: string | null
          lease_clause: string | null
          effective_from: string
          effective_to: string | null
          approved_by: string | null
          notes: string | null
          created_at: string
        }
        Insert: {
          id?: string
          firm_id: string
          property_id: string
          schedule_name: string
          method: string
          description?: string | null
          lease_clause?: string | null
          effective_from: string
          effective_to?: string | null
          approved_by?: string | null
          notes?: string | null
          created_at?: string
        }
        Update: Partial<Omit<Database['public']['Tables']['apportionment_schedules']['Insert'], 'id'>>
        Relationships: []
      }
      apportionment_items: {
        Row: {
          id: string
          firm_id: string
          schedule_id: string
          unit_id: string
          share_numerator: number
          share_denominator: number
          percentage_calculated: number
          floor_area_sqm: number | null
          rateable_value: number | null
          weighting_factor: number | null
          notes: string | null
          created_at: string
        }
        Insert: {
          id?: string
          firm_id: string
          schedule_id: string
          unit_id: string
          share_numerator: number
          share_denominator: number
          floor_area_sqm?: number | null
          rateable_value?: number | null
          weighting_factor?: number | null
          notes?: string | null
          created_at?: string
        }
        Update: Partial<Omit<Database['public']['Tables']['apportionment_items']['Insert'], 'id'>>
        Relationships: []
      }
      leaseholders: {
        Row: {
          id: string
          firm_id: string
          unit_id: string
          property_id: string | null
          user_id: string | null
          full_name: string
          correspondence_address: string | null
          email: string | null
          phone: string | null
          is_resident: boolean
          is_company: boolean
          company_name: string | null
          company_reg: string | null
          portal_access: boolean
          is_current: boolean
          from_date: string | null
          to_date: string | null
          notes: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          firm_id: string
          unit_id: string
          property_id?: string | null
          user_id?: string | null
          full_name: string
          correspondence_address?: string | null
          email?: string | null
          phone?: string | null
          is_resident?: boolean
          is_company?: boolean
          company_name?: string | null
          company_reg?: string | null
          portal_access?: boolean
          is_current?: boolean
          from_date?: string | null
          to_date?: string | null
          notes?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: Partial<Omit<Database['public']['Tables']['leaseholders']['Insert'], 'id'>>
        Relationships: []
      }
      bank_accounts: {
        Row: {
          id: string
          firm_id: string
          property_id: string
          account_name: string
          account_type: string
          bank_name: string | null
          sort_code_last4: string | null
          account_number_last4: string | null
          is_active: boolean
          opened_date: string | null
          closed_date: string | null
          requires_dual_auth: boolean
          dual_auth_threshold: number | null
          current_balance: number
          last_reconciled_at: string | null
          rics_designated: boolean
          notes: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          firm_id: string
          property_id: string
          account_name: string
          account_type: string
          bank_name?: string | null
          sort_code_last4?: string | null
          account_number_last4?: string | null
          is_active?: boolean
          opened_date?: string | null
          closed_date?: string | null
          requires_dual_auth?: boolean
          dual_auth_threshold?: number | null
          current_balance?: number
          last_reconciled_at?: string | null
          rics_designated?: boolean
          notes?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: Partial<Omit<Database['public']['Tables']['bank_accounts']['Insert'], 'id'>>
        Relationships: []
      }
      service_charge_accounts: {
        Row: {
          id: string
          firm_id: string
          property_id: string
          account_year_start: string
          account_year_end: string
          budget_total: number | null
          status: string
          finalised_at: string | null
          finalised_by: string | null
          notes: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          firm_id: string
          property_id: string
          account_year_start: string
          account_year_end: string
          budget_total?: number | null
          status?: string
          finalised_at?: string | null
          finalised_by?: string | null
          notes?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: Partial<Omit<Database['public']['Tables']['service_charge_accounts']['Insert'], 'id'>>
        Relationships: []
      }
      budget_line_items: {
        Row: {
          id: string
          firm_id: string
          account_id: string
          category: string
          description: string | null
          budgeted_amount: number
          actual_amount: number
          variance: number
          reserve_contribution: boolean
          notes: string | null
          created_at: string
        }
        Insert: {
          id?: string
          firm_id: string
          account_id: string
          category: string
          description?: string | null
          budgeted_amount?: number
          actual_amount?: number
          reserve_contribution?: boolean
          notes?: string | null
          created_at?: string
        }
        Update: Partial<Omit<Database['public']['Tables']['budget_line_items']['Insert'], 'id'>>
        Relationships: []
      }
      demands: {
        Row: {
          id: string
          firm_id: string
          property_id: string
          unit_id: string
          leaseholder_id: string
          account_id: string | null
          demand_type: string
          period_start: string | null
          period_end: string | null
          amount: number
          draft_date: string | null
          issued_date: string | null
          due_date: string | null
          s21b_attached: boolean
          status: string
          document_id: string | null
          notes: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          firm_id: string
          property_id: string
          unit_id: string
          leaseholder_id: string
          account_id?: string | null
          demand_type: string
          period_start?: string | null
          period_end?: string | null
          amount: number
          draft_date?: string | null
          issued_date?: string | null
          due_date?: string | null
          s21b_attached?: boolean
          status?: string
          document_id?: string | null
          notes?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: Partial<Omit<Database['public']['Tables']['demands']['Insert'], 'id'>>
        Relationships: []
      }
      transactions: {
        Row: {
          id: string
          firm_id: string
          property_id: string
          bank_account_id: string
          transaction_type: string
          transaction_date: string
          amount: number
          description: string
          payee_payer: string | null
          reference: string | null
          demand_id: string | null
          invoice_id: string | null
          reconciled: boolean
          reconciled_at: string | null
          reconciled_by: string | null
          statement_import_id: string | null
          created_by: string | null
          created_at: string
        }
        Insert: {
          id?: string
          firm_id: string
          property_id: string
          bank_account_id: string
          transaction_type: string
          transaction_date: string
          amount: number
          description: string
          payee_payer?: string | null
          reference?: string | null
          demand_id?: string | null
          invoice_id?: string | null
          reconciled?: boolean
          reconciled_at?: string | null
          reconciled_by?: string | null
          statement_import_id?: string | null
          created_by?: string | null
          created_at?: string
        }
        Update: Partial<Omit<Database['public']['Tables']['transactions']['Insert'], 'id'>>
        Relationships: []
      }
      payment_authorisations: {
        Row: {
          id: string
          firm_id: string
          transaction_id: string | null
          requested_by: string
          requested_at: string
          authorised_by: string | null
          authorised_at: string | null
          rejected_by: string | null
          rejected_at: string | null
          rejection_reason: string | null
          status: string
          authority_limit: number | null
          proposed: ProposedTransaction | null
          created_at: string
        }
        Insert: {
          id?: string
          firm_id: string
          transaction_id?: string | null
          requested_by: string
          requested_at?: string
          authorised_by?: string | null
          authorised_at?: string | null
          rejected_by?: string | null
          rejected_at?: string | null
          rejection_reason?: string | null
          status?: string
          authority_limit?: number | null
          proposed?: ProposedTransaction | null
          created_at?: string
        }
        Update: Partial<Omit<Database['public']['Tables']['payment_authorisations']['Insert'], 'id'>>
        Relationships: []
      }
      invoices: {
        Row: {
          id: string
          firm_id: string
          property_id: string
          contractor_id: string | null
          invoice_number: string | null
          invoice_date: string | null
          due_date: string | null
          amount_net: number | null
          vat_amount: number | null
          amount_gross: number | null
          description: string | null
          status: string
          extracted_by_ai: boolean
          extraction_confidence: number | null
          extraction_notes: string | null
          document_id: string | null
          approved_by: string | null
          approved_at: string | null
          transaction_id: string | null
          section20_id: string | null
          works_order_id: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          firm_id: string
          property_id: string
          contractor_id?: string | null
          invoice_number?: string | null
          invoice_date?: string | null
          due_date?: string | null
          amount_net?: number | null
          vat_amount?: number | null
          amount_gross?: number | null
          description?: string | null
          status?: string
          extracted_by_ai?: boolean
          extraction_confidence?: number | null
          extraction_notes?: string | null
          document_id?: string | null
          approved_by?: string | null
          approved_at?: string | null
          transaction_id?: string | null
          section20_id?: string | null
          works_order_id?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: Partial<Omit<Database['public']['Tables']['invoices']['Insert'], 'id'>>
        Relationships: []
      }
      bank_statement_imports: {
        Row: {
          id: string
          firm_id: string
          bank_account_id: string
          import_date: string
          filename: string | null
          row_count: number | null
          matched_count: number | null
          unmatched_count: number | null
          raw_data: Json | null
          status: string
          imported_by: string | null
          created_at: string
        }
        Insert: {
          id?: string
          firm_id: string
          bank_account_id: string
          import_date?: string
          filename?: string | null
          row_count?: number | null
          matched_count?: number | null
          unmatched_count?: number | null
          raw_data?: Json | null
          status?: string
          imported_by?: string | null
          created_at?: string
        }
        Update: Partial<Omit<Database['public']['Tables']['bank_statement_imports']['Insert'], 'id'>>
        Relationships: []
      }
      compliance_items: {
        Row: {
          id: string
          firm_id: string
          property_id: string
          item_type: string
          description: string
          contractor_id: string | null
          issue_date: string | null
          expiry_date: string | null
          reminder_days_before: number[]
          status: string
          document_id: string | null
          notes: string | null
          next_action: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          firm_id: string
          property_id: string
          item_type: string
          description: string
          contractor_id?: string | null
          issue_date?: string | null
          expiry_date?: string | null
          reminder_days_before?: number[]
          status?: string
          document_id?: string | null
          notes?: string | null
          next_action?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: Partial<Omit<Database['public']['Tables']['compliance_items']['Insert'], 'id'>>
        Relationships: []
      }
      insurance_policies: {
        Row: {
          id: string
          firm_id: string
          property_id: string
          insurer: string
          broker: string | null
          policy_number: string | null
          policy_type: string
          premium_net: number | null
          premium_gross: number | null
          sum_insured: number | null
          inception_date: string
          renewal_date: string
          auto_renew: boolean
          document_id: string | null
          notes: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          firm_id: string
          property_id: string
          insurer: string
          broker?: string | null
          policy_number?: string | null
          policy_type: string
          premium_net?: number | null
          premium_gross?: number | null
          sum_insured?: number | null
          inception_date: string
          renewal_date: string
          auto_renew?: boolean
          document_id?: string | null
          notes?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: Partial<Omit<Database['public']['Tables']['insurance_policies']['Insert'], 'id'>>
        Relationships: []
      }
      documents: {
        Row: {
          id: string
          firm_id: string
          property_id: string | null
          unit_id: string | null
          leaseholder_id: string | null
          document_type: string
          filename: string
          storage_path: string
          mime_type: string | null
          file_size_bytes: number | null
          upload_date: string
          uploaded_by: string | null
          description: string | null
          tags: string[] | null
          ai_summary: string | null
          ai_extracted_data: Json | null
          ai_processed_at: string | null
          is_confidential: boolean
          retention_until: string | null
          version_number: number
          superseded_by: string | null
          created_at: string
        }
        Insert: {
          id?: string
          firm_id: string
          property_id?: string | null
          unit_id?: string | null
          leaseholder_id?: string | null
          document_type: string
          filename: string
          storage_path: string
          mime_type?: string | null
          file_size_bytes?: number | null
          upload_date?: string
          uploaded_by?: string | null
          description?: string | null
          tags?: string[] | null
          ai_summary?: string | null
          ai_extracted_data?: Json | null
          ai_processed_at?: string | null
          is_confidential?: boolean
          retention_until?: string | null
          version_number?: number
          superseded_by?: string | null
          created_at?: string
        }
        Update: Partial<Omit<Database['public']['Tables']['documents']['Insert'], 'id'>>
        Relationships: []
      }
      contractors: {
        Row: {
          id: string
          firm_id: string
          company_name: string
          contact_name: string | null
          email: string | null
          phone: string | null
          address: string | null
          trade_categories: string[] | null
          insurance_expiry: string | null
          gas_safe_number: string | null
          electrical_approval: string | null
          preferred_order: number | null
          approved: boolean
          active: boolean
          portal_access: boolean
          rating: number | null
          notes: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          firm_id: string
          company_name: string
          contact_name?: string | null
          email?: string | null
          phone?: string | null
          address?: string | null
          trade_categories?: string[] | null
          insurance_expiry?: string | null
          gas_safe_number?: string | null
          electrical_approval?: string | null
          preferred_order?: number | null
          approved?: boolean
          active?: boolean
          portal_access?: boolean
          rating?: number | null
          notes?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: Partial<Omit<Database['public']['Tables']['contractors']['Insert'], 'id'>>
        Relationships: []
      }
      works_orders: {
        Row: {
          id: string
          firm_id: string
          property_id: string
          unit_id: string | null
          contractor_id: string | null
          source_type: string | null
          source_id: string | null
          description: string
          order_type: string
          priority: string
          raised_date: string
          required_by: string | null
          estimated_cost: number | null
          actual_cost: number | null
          status: string
          invoice_id: string | null
          section20_id: string | null
          dispatch_started_at: string | null
          completed_at: string | null
          created_by: string | null
          notes: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          firm_id: string
          property_id: string
          unit_id?: string | null
          contractor_id?: string | null
          source_type?: string | null
          source_id?: string | null
          description: string
          order_type?: string
          priority?: string
          raised_date?: string
          required_by?: string | null
          estimated_cost?: number | null
          actual_cost?: number | null
          status?: string
          invoice_id?: string | null
          section20_id?: string | null
          dispatch_started_at?: string | null
          completed_at?: string | null
          created_by?: string | null
          notes?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: Partial<Omit<Database['public']['Tables']['works_orders']['Insert'], 'id'>>
        Relationships: []
      }
      dispatch_log: {
        Row: {
          id: string
          firm_id: string
          works_order_id: string
          contractor_id: string
          sequence_position: number
          sent_at: string
          response_deadline: string
          response_received_at: string | null
          response: string | null
          decline_reason: string | null
          token: string | null
          token_expires_at: string | null
          notified_via: string
          created_at: string
        }
        Insert: {
          id?: string
          firm_id: string
          works_order_id: string
          contractor_id: string
          sequence_position: number
          sent_at?: string
          response_deadline: string
          response_received_at?: string | null
          response?: string | null
          decline_reason?: string | null
          token?: string | null
          token_expires_at?: string | null
          notified_via?: string
          created_at?: string
        }
        Update: Partial<Omit<Database['public']['Tables']['dispatch_log']['Insert'], 'id'>>
        Relationships: []
      }
      section20_consultations: {
        Row: {
          id: string
          firm_id: string
          property_id: string
          works_description: string
          estimated_cost: number | null
          threshold_exceeded: boolean
          status: string
          stage1_notice_date: string | null
          stage1_response_deadline: string | null
          stage1_closed_date: string | null
          stage2_notice_date: string | null
          stage2_response_deadline: string | null
          stage2_closed_date: string | null
          nominated_contractor_id: string | null
          awarded_contractor_id: string | null
          final_cost: number | null
          dispensation_applied: boolean
          dispensation_grounds: string | null
          dispensation_granted: boolean | null
          document_ids: string[] | null
          created_by: string | null
          notes: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          firm_id: string
          property_id: string
          works_description: string
          estimated_cost?: number | null
          status?: string
          stage1_notice_date?: string | null
          stage1_response_deadline?: string | null
          stage1_closed_date?: string | null
          stage2_notice_date?: string | null
          stage2_response_deadline?: string | null
          stage2_closed_date?: string | null
          nominated_contractor_id?: string | null
          awarded_contractor_id?: string | null
          final_cost?: number | null
          dispensation_applied?: boolean
          dispensation_grounds?: string | null
          dispensation_granted?: boolean | null
          document_ids?: string[] | null
          created_by?: string | null
          notes?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: Partial<Omit<Database['public']['Tables']['section20_consultations']['Insert'], 'id'>>
        Relationships: []
      }
      section20_observations: {
        Row: {
          id: string
          firm_id: string
          consultation_id: string
          leaseholder_id: string | null
          stage: string
          received_date: string
          content: string
          nominated_contractor: string | null
          response_text: string | null
          responded_by: string | null
          responded_at: string | null
          document_id: string | null
          created_at: string
        }
        Insert: {
          id?: string
          firm_id: string
          consultation_id: string
          leaseholder_id?: string | null
          stage: string
          received_date: string
          content: string
          nominated_contractor?: string | null
          response_text?: string | null
          responded_by?: string | null
          responded_at?: string | null
          document_id?: string | null
          created_at?: string
        }
        Update: Partial<Omit<Database['public']['Tables']['section20_observations']['Insert'], 'id'>>
        Relationships: []
      }
      buildings_bsa: {
        Row: {
          id: string
          firm_id: string
          property_id: string
          is_hrb: boolean
          hrb_confirmed_date: string | null
          height_metres: number | null
          storey_count: number | null
          residential_unit_count: number | null
          hrb_registration_number: string | null
          hrb_registration_date: string | null
          hrb_registration_document_id: string | null
          principal_accountable_person: string | null
          principal_accountable_person_email: string | null
          accountable_persons: Json | null
          responsible_person_fire: string | null
          bac_status: string
          bac_application_date: string | null
          bac_issue_date: string | null
          bac_expiry_date: string | null
          bac_document_id: string | null
          safety_case_report_document_id: string | null
          safety_case_report_date: string | null
          resident_engagement_strategy_doc_id: string | null
          mandatory_occurrence_reporting: boolean
          notes: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          firm_id: string
          property_id: string
          is_hrb?: boolean
          hrb_confirmed_date?: string | null
          height_metres?: number | null
          storey_count?: number | null
          residential_unit_count?: number | null
          hrb_registration_number?: string | null
          hrb_registration_date?: string | null
          hrb_registration_document_id?: string | null
          principal_accountable_person?: string | null
          principal_accountable_person_email?: string | null
          accountable_persons?: Json | null
          responsible_person_fire?: string | null
          bac_status?: string
          bac_application_date?: string | null
          bac_issue_date?: string | null
          bac_expiry_date?: string | null
          bac_document_id?: string | null
          safety_case_report_document_id?: string | null
          safety_case_report_date?: string | null
          resident_engagement_strategy_doc_id?: string | null
          mandatory_occurrence_reporting?: boolean
          notes?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: Partial<Omit<Database['public']['Tables']['buildings_bsa']['Insert'], 'id'>>
        Relationships: []
      }
      golden_thread_records: {
        Row: {
          id: string
          firm_id: string
          property_id: string
          record_type: string
          title: string
          description: string
          recorded_by: string | null
          recorded_at: string
          event_date: string | null
          document_ids: string[] | null
          is_safety_critical: boolean
          version_number: number
          superseded_by_id: string | null
          is_current_version: boolean
          created_at: string
        }
        Insert: {
          id?: string
          firm_id: string
          property_id: string
          record_type: string
          title: string
          description: string
          recorded_by?: string | null
          recorded_at?: string
          event_date?: string | null
          document_ids?: string[] | null
          is_safety_critical?: boolean
          version_number?: number
          superseded_by_id?: string | null
          is_current_version?: boolean
          created_at?: string
        }
        Update: never  // Golden Thread records are immutable — no Update type
        Relationships: []
      }
      golden_thread_audit_log: {
        Row: {
          id: string
          firm_id: string
          property_id: string
          golden_thread_record_id: string | null
          action: string
          performed_by: string | null
          performed_at: string
          ip_address: string | null
          user_agent: string | null
          notes: string | null
        }
        Insert: {
          id?: string
          firm_id: string
          property_id: string
          golden_thread_record_id?: string | null
          action: string
          performed_by?: string | null
          performed_at?: string
          ip_address?: string | null
          user_agent?: string | null
          notes?: string | null
        }
        Update: never  // Audit log is append-only
        Relationships: []
      }
      bsa_mandatory_occurrences: {
        Row: {
          id: string
          firm_id: string
          property_id: string
          occurrence_type: string
          description: string
          occurred_at: string
          reported_to_bsr: boolean
          bsr_report_date: string | null
          bsr_reference: string | null
          severity: string
          document_ids: string[] | null
          created_by: string | null
          created_at: string
        }
        Insert: {
          id?: string
          firm_id: string
          property_id: string
          occurrence_type: string
          description: string
          occurred_at: string
          reported_to_bsr?: boolean
          bsr_report_date?: string | null
          bsr_reference?: string | null
          severity?: string
          document_ids?: string[] | null
          created_by?: string | null
          created_at?: string
        }
        Update: Partial<Omit<Database['public']['Tables']['bsa_mandatory_occurrences']['Insert'], 'id'>>
        Relationships: []
      }
      firm_portal_config: {
        Row: {
          id: string
          firm_id: string
          out_of_hours_phone: string | null
          out_of_hours_start: string
          out_of_hours_end: string
          out_of_hours_days: string[]
          emergency_guidance_text: string | null
          show_999_prompt: boolean
          office_hours: Json | null
          correspondence_tone: string | null
          correspondence_signoff: string | null
          letterhead_storage_path: string | null
          standard_clauses: Json | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          firm_id: string
          out_of_hours_phone?: string | null
          out_of_hours_start?: string
          out_of_hours_end?: string
          out_of_hours_days?: string[]
          emergency_guidance_text?: string | null
          show_999_prompt?: boolean
          office_hours?: Json | null
          correspondence_tone?: string | null
          correspondence_signoff?: string | null
          letterhead_storage_path?: string | null
          standard_clauses?: Json | null
          created_at?: string
          updated_at?: string
        }
        Update: Partial<Omit<Database['public']['Tables']['firm_portal_config']['Insert'], 'id'>>
        Relationships: []
      }
      maintenance_requests: {
        Row: {
          id: string
          firm_id: string
          property_id: string
          unit_id: string
          leaseholder_id: string | null
          description: string
          reported_date: string
          reported_at: string
          priority: string
          status: string
          works_order_id: string | null
          acknowledged_at: string | null
          resolved_date: string | null
          resolution_notes: string | null
          submitted_out_of_hours: boolean
          emergency_triage_shown: boolean
          emergency_self_declared: boolean | null
          triage_timestamp: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          firm_id: string
          property_id: string
          unit_id: string
          leaseholder_id?: string | null
          description: string
          reported_date?: string
          reported_at?: string
          priority?: string
          status?: string
          works_order_id?: string | null
          acknowledged_at?: string | null
          resolved_date?: string | null
          resolution_notes?: string | null
          submitted_out_of_hours?: boolean
          emergency_triage_shown?: boolean
          emergency_self_declared?: boolean | null
          triage_timestamp?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: Partial<Omit<Database['public']['Tables']['maintenance_requests']['Insert'], 'id'>>
        Relationships: []
      }
      portal_messages: {
        Row: {
          id: string
          firm_id: string
          property_id: string
          unit_id: string | null
          thread_id: string | null
          from_user_id: string | null
          to_user_id: string | null
          direction: string
          subject: string | null
          body: string
          sent_at: string
          read_at: string | null
          document_ids: string[] | null
        }
        Insert: {
          id?: string
          firm_id: string
          property_id: string
          unit_id?: string | null
          thread_id?: string | null
          from_user_id?: string | null
          to_user_id?: string | null
          direction: string
          subject?: string | null
          body: string
          sent_at?: string
          read_at?: string | null
          document_ids?: string[] | null
        }
        Update: Partial<Omit<Database['public']['Tables']['portal_messages']['Insert'], 'id'>>
        Relationships: []
      }
      meetings: {
        Row: {
          id: string
          firm_id: string
          property_id: string
          meeting_type: string
          scheduled_date: string
          location: string | null
          quorum_required: number | null
          quorum_met: boolean | null
          status: string
          minutes_document_id: string | null
          created_by: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          firm_id: string
          property_id: string
          meeting_type: string
          scheduled_date: string
          location?: string | null
          quorum_required?: number | null
          quorum_met?: boolean | null
          status?: string
          minutes_document_id?: string | null
          created_by?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: Partial<Omit<Database['public']['Tables']['meetings']['Insert'], 'id'>>
        Relationships: []
      }
      firm_inspection_config: {
        Row: {
          id: string
          firm_id: string
          app_name: string
          logo_storage_path: string | null
          report_header_text: string | null
          report_footer_text: string | null
          primary_colour: string | null
          inspection_sections: Json | null
          defect_categories: Json | null
          auto_create_works_order: boolean
          works_order_review_required: boolean
          include_photos_in_report: boolean
          include_bsa_section: boolean
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          firm_id: string
          app_name?: string
          logo_storage_path?: string | null
          report_header_text?: string | null
          report_footer_text?: string | null
          primary_colour?: string | null
          inspection_sections?: Json | null
          defect_categories?: Json | null
          auto_create_works_order?: boolean
          works_order_review_required?: boolean
          include_photos_in_report?: boolean
          include_bsa_section?: boolean
          created_at?: string
          updated_at?: string
        }
        Update: Partial<Omit<Database['public']['Tables']['firm_inspection_config']['Insert'], 'id'>>
        Relationships: []
      }
      inspection_report_links: {
        Row: {
          id: string
          firm_id: string
          property_id: string
          inspection_app_report_id: string
          inspection_date: string
          inspected_by: string | null
          report_document_id: string | null
          defect_count: number | null
          works_orders_created: number | null
          synced_at: string
        }
        Insert: {
          id?: string
          firm_id: string
          property_id: string
          inspection_app_report_id: string
          inspection_date: string
          inspected_by?: string | null
          report_document_id?: string | null
          defect_count?: number | null
          works_orders_created?: number | null
          synced_at?: string
        }
        Update: Partial<Omit<Database['public']['Tables']['inspection_report_links']['Insert'], 'id'>>
        Relationships: []
      }
    }
    Views: Record<string, never>
    Functions: Record<string, never>
    Enums: Record<string, never>
  }
}
