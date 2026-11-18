declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    BUCKET: R2Bucket;
    SILVERGRAIN_ADMIN_EMAIL?: string;
    SILVERGRAIN_ADMIN_ID?: string;
    SILVERGRAIN_FORM_SECRET?: string;
    RESEND_API_KEY?: string;
    SILVERGRAIN_EMAIL_FROM?: string;
    SILVERGRAIN_PUBLIC_ORIGIN?: string;
    TURNSTILE_SITE_KEY?: string;
    TURNSTILE_SECRET_KEY?: string;
    TURNSTILE_HOSTNAME?: string;
  }
}
