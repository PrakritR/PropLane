-- Allow the one-time work-number setup charge.
--
-- The meter column is guarded by a CHECK constraint listing every valid meter,
-- so a new meter has to be added here or every insert of it is rejected at the
-- database — the usage would silently never record.
alter table public.manager_comms_usage_events
  drop constraint if exists manager_comms_usage_events_meter_check;

alter table public.manager_comms_usage_events
  add constraint manager_comms_usage_events_meter_check check (
    meter in (
      'sms_outbound_segment',
      'sms_inbound_segment',
      'voice_minute',
      'voice_speech_gather',
      'voice_recording_minute',
      'ai_agent_turn',
      'work_number_monthly',
      'work_number_setup'
    )
  );
