alter table public.video_asset_downloads
  drop constraint video_asset_downloads_attribution_check;

alter table public.video_asset_downloads
  add constraint video_asset_downloads_attribution_check check (
    (
      requires_attribution
      and required_attribution_url ~ '^https://[^[:space:]]+$'
      and required_attribution_url !~ '[?#]'
      and required_attribution_url !~ '^https://[^/]*@'
      and required_attribution_url !~* '(signed|status|download|media|signature|x-amz-[a-z0-9-]*|x-goog-[a-z0-9-]*|api[_-]?key|access[_-]?key|token|secret|credential|policy|expires|key-pair-id|authorization|(^|[^a-z0-9])(sig|auth)($|[^a-z0-9]))'
    )
    or (not requires_attribution and required_attribution_url is null)
  );
