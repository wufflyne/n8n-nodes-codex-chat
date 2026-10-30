// Remove only generated project output before a reproducible build.
require("node:fs").rmSync(require("node:path").join(__dirname, "../dist"), {
  recursive: true,
  force: true,
});
