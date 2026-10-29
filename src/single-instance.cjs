// Call after resolving the physical userData path, before opening any storage.
function claimInstance(app, getWindow) {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return false;
  }
  app.on('second-instance', () => {
    const window = getWindow();
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
  return true;
}
module.exports = {claimInstance};
