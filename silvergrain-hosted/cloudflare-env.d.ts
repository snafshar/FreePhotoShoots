declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    BUCKET: R2Bucket;
    SILVERGRAIN_ADMIN_EMAIL?: string;
    SILVERGRAIN_ADMIN_ID?: string;
    SILVERGRAIN_FORM_SECRET?: string;
    TURNSTILE_SITE_KEY?: string;
    TURNSTILE_SECRET_KEY?: string;
    TURNSTILE_HOSTNAME?: string;
  }
}
