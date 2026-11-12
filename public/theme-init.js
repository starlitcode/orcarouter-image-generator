// Runs before first paint so the saved theme shows without a flash.
// A separate file because the page's Content-Security-Policy blocks inline scripts.
;(function () {
  var theme = 'dark'
  var motion = ''
  try {
    var prefs = JSON.parse(localStorage.getItem('orca-ig.prefs.v1') || '{}')
    if (prefs && prefs.theme === 'light') theme = 'light'
    if (prefs && prefs.motion === 'reduce') motion = 'reduce'
  } catch (e) {
    // Storage blocked: dark theme.
  }
  document.documentElement.setAttribute('data-theme', theme)
  if (motion) document.documentElement.setAttribute('data-motion', motion)
})()
