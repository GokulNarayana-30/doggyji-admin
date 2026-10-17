// Apply the saved theme before first paint, so the page does not flash.
    try {
      const t = localStorage.getItem('doggyji_admin_theme');
      if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
    } catch (_) {}
