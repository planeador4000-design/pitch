'use strict';

// Runs before the first paint so the window never flashes the wrong theme.
(function () {
  let theme = null;
  try {
    theme = localStorage.getItem('pitch:theme');
  } catch {
    /* storage unavailable */
  }
  if (theme !== 'light' && theme !== 'dark') {
    theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.documentElement.dataset.theme = theme;
})();
