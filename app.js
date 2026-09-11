(function (root) {
  'use strict';

  document.addEventListener('DOMContentLoaded', async () => {
    await root.EggEventLab.clock.sync();
    root.EggEventLab.ui.setup();
  });
})(window);
