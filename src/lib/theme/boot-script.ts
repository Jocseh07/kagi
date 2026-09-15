/**
 * The pre-paint theme boot, as a string because it has to be inlined into the
 * document head and run before anything else.
 *
 * It was the inline script in `index.html`; nothing about it changed when that
 * file became `__root.tsx`. It stays ES5-flavoured and dependency-free on
 * purpose — it runs before the bundle exists.
 *
 * The stored value is a finished stylesheet so that nothing here has to know
 * how a theme is built. Keep in step with the rest of src/lib/theme/.
 */
export const themeBootScript = `(function () {
  var theme = 'dark'
  try {
    var stored = localStorage.getItem('kagi:theme')
    if (stored === 'light' || stored === 'dark' || stored === 'system') {
      theme = stored
    }
  } catch (e) {}
  var dark =
    theme === 'system'
      ? matchMedia('(prefers-color-scheme: dark)').matches
      : theme === 'dark'
  document.documentElement.classList.toggle('dark', dark)

  var active = null
  try {
    active = JSON.parse(localStorage.getItem('kagi:theme-active'))
  } catch (e) {}

  if (active && typeof active.css === 'string') {
    var style = document.createElement('style')
    style.id = 'app-theme'
    style.textContent = active.css
    document.head.appendChild(style)
  }

  // After the theme, and outranking it: a picked font is stored as the
  // finished rule for the same reason a theme is, and its doubled :root
  // means this element's position in head is not load-bearing.
  try {
    var fontCss = localStorage.getItem('kagi:font-css')
    if (fontCss) {
      var fontStyle = document.createElement('style')
      fontStyle.id = 'app-font'
      fontStyle.textContent = fontCss
      document.head.appendChild(fontStyle)
    }
  } catch (e) {}

  // Same trick again for the app's text size: one rule, stored finished,
  // doubled :root. It resizes every rem in the app, so it has to be in place
  // before the first paint or the whole layout visibly jumps.
  try {
    var sizeCss = localStorage.getItem('kagi:text-size-css')
    if (sizeCss) {
      var sizeStyle = document.createElement('style')
      sizeStyle.id = 'app-text-size'
      sizeStyle.textContent = sizeCss
      document.head.appendChild(sizeStyle)
    }
  } catch (e) {}

  var color = active && active.color
  var content = color && color[dark ? 'dark' : 'light']
  if (!content) content = dark ? '#0a0a0a' : '#ffffff'
  var meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', content)
})()`
