import { defineConfig } from "mygo-cli";
import pkg from "./package.json" with { type: "json" };

export default defineConfig({
  name: "HDU Library Sniper",
  slug: "hdu-library-sniper",
  identifier: "io.github.alaichhe.hdu-library-sniper",
  version: pkg.version,
  devUrl: "http://localhost:5173",
  devCommand: "bun run dev:web",
  buildCommand: "bun run build:web",
  frontendDist: "dist/web",
  bindings: "src/web/mygo.ts",
  out: "build",
  macos: {
    signingIdentity: process.env.MACOS_SIGNING_IDENTITY ?? "-",
  },
  windows: {
    installDirName: "HDU Library Sniper",
    installerInclude: "packaging/windows-installer.nsh",
  },
  updates: {
    publicKey: process.env.MYGO_UPDATE_PUBLIC_KEY || "gRBOBabXmWjWHYDlM42YAxMyc01YpQnnqX1EzjE5RNw=",
    github: "AlaIchhe/HDU-Library-Sniper",
  },
});
