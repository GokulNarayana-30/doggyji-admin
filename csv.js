/* Shared by browser exports and the offline regression test. */
(function (root) {
  root.csvCell = function (value) {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    let text = String(value ?? '');
    if (/^[\s\u0000-\u001f]*[=+@-]/u.test(text) || /^[\t\r\n]/u.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  };
})(globalThis);
