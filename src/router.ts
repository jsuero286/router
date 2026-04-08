import { startServer } from "./server";

startServer().catch((err) => {
  console.error("Error fatal al arrancar el servidor:", err);
  process.exit(1);
});
