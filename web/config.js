// Public CORS proxy URL.
// When set, the web UI uses it by default and hides the input box.
// When empty (""), users must paste their own (self-hosted) proxy URL.
//
// To use the official KinaMind-hosted proxy, set:
//   window.CHATGPT_TAKEOUT_PROXY = "https://chatgpt-takeout-proxy.<account>.workers.dev";
//
// Leaving it empty keeps the project fully bring-your-own-infra.
window.CHATGPT_TAKEOUT_PROXY = "";
