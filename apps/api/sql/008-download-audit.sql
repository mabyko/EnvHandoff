CREATE INDEX download_denial_window ON organization_events(target_id,event,created_at)
  WHERE event IN ('download_denied','share_download_denied');
