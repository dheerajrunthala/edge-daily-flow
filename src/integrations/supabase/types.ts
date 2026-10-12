export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.18"
  }
  public: {
    Tables: {
      ai_events: {
        Row: {
          created_at: string
          id: string
          input_tokens: number | null
          items_processed: number
          kind: string
          output_tokens: number | null
          user_id: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          input_tokens?: number | null
          items_processed?: number
          kind: string
          output_tokens?: number | null
          user_id?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          input_tokens?: number | null
          items_processed?: number
          kind?: string
          output_tokens?: number | null
          user_id?: string | null
        }
        Relationships: []
      }
      articles: {
        Row: {
          category: string
          created_at: string
          embedding: string | null
          feed_name: string
          fetched_on: string
          id: string
          published_at: string | null
          source: string
          source_count: number
          summary: string | null
          tier: string
          title: string
          url: string
          url_resolved: boolean
        }
        Insert: {
          category: string
          created_at?: string
          embedding?: string | null
          feed_name: string
          fetched_on: string
          id?: string
          published_at?: string | null
          source: string
          source_count?: number
          summary?: string | null
          tier: string
          title: string
          url: string
          url_resolved?: boolean
        }
        Update: {
          category?: string
          created_at?: string
          embedding?: string | null
          feed_name?: string
          fetched_on?: string
          id?: string
          published_at?: string | null
          source?: string
          source_count?: number
          summary?: string | null
          tier?: string
          title?: string
          url?: string
          url_resolved?: boolean
        }
        Relationships: []
      }
      brief_sends: {
        Row: {
          created_at: string
          digest_id: string | null
          id: string
          sent_for: string
          slot: string
          user_id: string
        }
        Insert: {
          created_at?: string
          digest_id?: string | null
          id?: string
          sent_for: string
          slot: string
          user_id: string
        }
        Update: {
          created_at?: string
          digest_id?: string | null
          id?: string
          sent_for?: string
          slot?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "brief_sends_digest_id_fkey"
            columns: ["digest_id"]
            isOneToOne: false
            referencedRelation: "digests"
            referencedColumns: ["id"]
          },
        ]
      }
      digests: {
        Row: {
          created_at: string
          digest_date: string
          emailed_at: string | null
          error: string | null
          id: string
          items_count: number
          sources_scanned: number
          status: Database["public"]["Enums"]["digest_status"]
          summary: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          digest_date: string
          emailed_at?: string | null
          error?: string | null
          id?: string
          items_count?: number
          sources_scanned?: number
          status?: Database["public"]["Enums"]["digest_status"]
          summary?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          digest_date?: string
          emailed_at?: string | null
          error?: string | null
          id?: string
          items_count?: number
          sources_scanned?: number
          status?: Database["public"]["Enums"]["digest_status"]
          summary?: string | null
          user_id?: string
        }
        Relationships: []
      }
      news_items: {
        Row: {
          category: string
          created_at: string
          digest_id: string
          embedding: string | null
          headline: string
          id: string
          importance: number | null
          is_saved: boolean
          published_at: string | null
          rank: number | null
          related_item_id: string | null
          source: string | null
          summary: string
          url: string
          url_resolved: boolean
          user_id: string
          why_it_matters: string | null
        }
        Insert: {
          category: string
          created_at?: string
          digest_id: string
          embedding?: string | null
          headline: string
          id?: string
          importance?: number | null
          is_saved?: boolean
          published_at?: string | null
          rank?: number | null
          related_item_id?: string | null
          source?: string | null
          summary: string
          url: string
          url_resolved?: boolean
          user_id: string
          why_it_matters?: string | null
        }
        Update: {
          category?: string
          created_at?: string
          digest_id?: string
          embedding?: string | null
          headline?: string
          id?: string
          importance?: number | null
          is_saved?: boolean
          published_at?: string | null
          rank?: number | null
          related_item_id?: string | null
          source?: string | null
          summary?: string
          url?: string
          url_resolved?: boolean
          user_id?: string
          why_it_matters?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "news_items_digest_id_fkey"
            columns: ["digest_id"]
            isOneToOne: false
            referencedRelation: "digests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "news_items_related_item_id_fkey"
            columns: ["related_item_id"]
            isOneToOne: false
            referencedRelation: "news_items"
            referencedColumns: ["id"]
          },
        ]
      }
      news_prefs: {
        Row: {
          categories: string[]
          email_times: string[]
          enabled: boolean
          headline_count: number
          updated_at: string
          user_id: string
        }
        Insert: {
          categories?: string[]
          email_times?: string[]
          enabled?: boolean
          headline_count?: number
          updated_at?: string
          user_id?: string
        }
        Update: {
          categories?: string[]
          email_times?: string[]
          enabled?: boolean
          headline_count?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      notification_prefs: {
        Row: {
          channels: Database["public"]["Enums"]["notification_channel"][]
          created_at: string
          nag_interval: string
          quiet_end: string
          quiet_start: string
          updated_at: string
          user_id: string
        }
        Insert: {
          channels?: Database["public"]["Enums"]["notification_channel"][]
          created_at?: string
          nag_interval?: string
          quiet_end?: string
          quiet_start?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          channels?: Database["public"]["Enums"]["notification_channel"][]
          created_at?: string
          nag_interval?: string
          quiet_end?: string
          quiet_start?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      prefetch_feeds: {
        Row: {
          name: string
          updated_at: string
          url: string
        }
        Insert: {
          name: string
          updated_at?: string
          url: string
        }
        Update: {
          name?: string
          updated_at?: string
          url?: string
        }
        Relationships: []
      }
      prefetch_requests: {
        Row: {
          request_id: number
          requested_at: string
          url: string
        }
        Insert: {
          request_id: number
          requested_at?: string
          url: string
        }
        Update: {
          request_id?: number
          requested_at?: string
          url?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          created_at: string
          full_name: string | null
          id: string
          news_profile: string | null
          onboarded_at: string | null
          timezone: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          full_name?: string | null
          id: string
          news_profile?: string | null
          onboarded_at?: string | null
          timezone?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          full_name?: string | null
          id?: string
          news_profile?: string | null
          onboarded_at?: string | null
          timezone?: string
          updated_at?: string
        }
        Relationships: []
      }
      tags: {
        Row: {
          color: string
          created_at: string
          id: string
          name: string
          user_id: string
        }
        Insert: {
          color?: string
          created_at?: string
          id?: string
          name: string
          user_id?: string
        }
        Update: {
          color?: string
          created_at?: string
          id?: string
          name?: string
          user_id?: string
        }
        Relationships: []
      }
      task_completions: {
        Row: {
          completed_at: string
          due_at: string | null
          id: string
          task_id: string
          user_id: string
        }
        Insert: {
          completed_at?: string
          due_at?: string | null
          id?: string
          task_id: string
          user_id?: string
        }
        Update: {
          completed_at?: string
          due_at?: string | null
          id?: string
          task_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "task_completions_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      task_notifications: {
        Row: {
          channel: Database["public"]["Enums"]["notification_channel"]
          delivered: boolean
          due_at: string
          id: string
          sent_at: string
          stage: string
          task_id: string
          user_id: string
        }
        Insert: {
          channel: Database["public"]["Enums"]["notification_channel"]
          delivered?: boolean
          due_at: string
          id?: string
          sent_at?: string
          stage: string
          task_id: string
          user_id: string
        }
        Update: {
          channel?: Database["public"]["Enums"]["notification_channel"]
          delivered?: boolean
          due_at?: string
          id?: string
          sent_at?: string
          stage?: string
          task_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "task_notifications_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      tasks: {
        Row: {
          all_day: boolean
          completed_at: string | null
          created_at: string
          due_at: string | null
          id: string
          last_reminded_at: string | null
          notes: string | null
          priority: Database["public"]["Enums"]["task_priority"]
          recurrence: Database["public"]["Enums"]["task_recurrence"]
          remind_before: string | null
          snoozed_until: string | null
          source: string
          status: Database["public"]["Enums"]["task_status"]
          tags: string[]
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          all_day?: boolean
          completed_at?: string | null
          created_at?: string
          due_at?: string | null
          id?: string
          last_reminded_at?: string | null
          notes?: string | null
          priority?: Database["public"]["Enums"]["task_priority"]
          recurrence?: Database["public"]["Enums"]["task_recurrence"]
          remind_before?: string | null
          snoozed_until?: string | null
          source?: string
          status?: Database["public"]["Enums"]["task_status"]
          tags?: string[]
          title: string
          updated_at?: string
          user_id?: string
        }
        Update: {
          all_day?: boolean
          completed_at?: string | null
          created_at?: string
          due_at?: string | null
          id?: string
          last_reminded_at?: string | null
          notes?: string | null
          priority?: Database["public"]["Enums"]["task_priority"]
          recurrence?: Database["public"]["Enums"]["task_recurrence"]
          remind_before?: string | null
          snoozed_until?: string | null
          source?: string
          status?: Database["public"]["Enums"]["task_status"]
          tags?: string[]
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      telegram_links: {
        Row: {
          chat_id: number | null
          code: string | null
          code_expires_at: string | null
          created_at: string
          linked_at: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          chat_id?: number | null
          code?: string | null
          code_expires_at?: string | null
          created_at?: string
          linked_at?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          chat_id?: number | null
          code?: string | null
          code_expires_at?: string | null
          created_at?: string
          linked_at?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      fanout_ingest_news: { Args: never; Returns: number }
      get_prefetched_feeds: {
        Args: { p_max_age?: string }
        Returns: {
          content: string
          status_code: number
          url: string
        }[]
      }
      invoke_edge_function: {
        Args: { p_body?: Json; p_name: string }
        Returns: number
      }
      prefetch_aggregator_feeds: { Args: never; Returns: number }
      request_telegram_link: {
        Args: never
        Returns: {
          code: string
          expires_at: string
        }[]
      }
      unlink_telegram: { Args: never; Returns: undefined }
    }
    Enums: {
      digest_status: "pending" | "ready" | "failed"
      notification_channel: "email" | "push" | "telegram"
      task_priority: "low" | "medium" | "high"
      task_recurrence: "none" | "daily" | "weekly" | "monthly" | "yearly"
      task_status: "todo" | "done"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      digest_status: ["pending", "ready", "failed"],
      notification_channel: ["email", "push", "telegram"],
      task_priority: ["low", "medium", "high"],
      task_recurrence: ["none", "daily", "weekly", "monthly", "yearly"],
      task_status: ["todo", "done"],
    },
  },
} as const
