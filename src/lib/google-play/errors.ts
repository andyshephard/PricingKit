export const GOOGLE_PERMISSION_HELP_HREF = '/setup-guide/google';
export const GOOGLE_PERMISSION_HELP_TEXT =
  'For more information, check the Google Play Guide.';

export const GOOGLE_PRICING_WRITE_DENIED_ERROR = {
  error:
    'Google Play denied this pricing update. Confirm that the exact service-account email from your JSON key has active access to this app and the "Manage store presence" permission, then disconnect and reconnect PricingKit.',
  helpHref: GOOGLE_PERMISSION_HELP_HREF,
  helpText: GOOGLE_PERMISSION_HELP_TEXT,
};
