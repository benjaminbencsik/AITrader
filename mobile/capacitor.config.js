// Two ways to build the APK:
//  - Default (no server needed): the app screens are bundled inside the APK (scripts/build-static.js fills www/),
//    and it talks to your GitHub repo directly.
//  - Optional: set APP_URL to https://your-server to make the APK open your own hosted server instead.
const url = process.env.APP_URL;
if (url && !/^https:\/\//.test(url)) throw new Error('APP_URL must start with https://');

module.exports = {
  appId: 'com.private.aitrader',
  appName: 'AI Trader',
  webDir: 'www',
  ...(url ? { server: { url, cleartext: false, allowNavigation: [new URL(url).host] } } : {}),
  android: { allowMixedContent: false },
};
