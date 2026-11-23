import 'server-only';

import net from 'node:net';

export interface PrinterTarget {
  host: string;
  port: number;
}

/** PRINTER_HOST / PRINTER_PORT (default 9100, the raw ZPL port of Zebra printers). */
export function printerFromEnv(env: Record<string, string | undefined> = process.env): PrinterTarget | null {
  const host = (env.PRINTER_HOST ?? '').trim();
  if (!host) return null;
  const port = Number(env.PRINTER_PORT ?? 9100);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

/** Send ZPL to the printer over a raw TCP socket as UTF-8 (the templates set ^CI28). */
export function sendZpl(target: PrinterTarget, zpl: string, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: target.host, port: target.port });
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err);
      else resolve();
    };
    socket.setTimeout(timeoutMs, () => finish(new Error('PRINTER_TIMEOUT')));
    socket.once('error', (err) => finish(err));
    socket.once('connect', () => {
      socket.end(Buffer.from(zpl, 'utf8'), () => finish());
    });
  });
}
