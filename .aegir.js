import { spawn, exec } from "child_process";
import { existsSync } from "fs";

/** @type {import('aegir/types').PartialOptions} */
export default {
  test: {
    async before() {
      if (!existsSync("./go-libp2p-webtransport-server/main")) {
        exec('go build main.go');
      }

      const server = spawn('./main', [], { cwd: "./go-libp2p-webtransport-server", killSignal: "SIGINT" });
      const serverAddr = await (new Promise((resolve => {
        server.stdout.on('data', (data) => {
          console.log(`stdout: ${data}`, typeof data);
          if (data.includes("addr=")) {
            // Parse the addr out
            resolve((data + "").match(/addr=([^\s]*)/)[1])
          }
        });
      })))


      return {
        server,
        env: {
          serverAddr
        }
      }
    },
    async after(_, { server }) {
      server.kill("SIGINT")
    }
  },
  build: {
    bundlesizeMax: '18kB'
  }
}
