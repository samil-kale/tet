const { app } = require("electron");
const writeFileAtomic = require("write-file-atomic");
const mode = process.argv[process.argv.length - 1];
for (const s of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(s, () => { console.log("handler " + s); app.quit(); });
app.on("before-quit", () => { console.log("before-quit"); });
app.on("will-quit", () => { console.log("will-quit"); });
app.whenReady().then(async () => {
  if (mode !== "none") { await writeFileAtomic("/tmp/sigprobe/x.txt", "x"); writeFileAtomic.sync("/tmp/sigprobe/y.txt", "y"); console.log("wrote"); }
  console.log("ready");
});
