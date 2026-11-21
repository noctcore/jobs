import { createServer, connect, type AddressInfo, type Server, type Socket } from 'node:net';

/**
 * A TCP proxy in front of Redis, so a test can cut the connection mid-run
 * (a Redis outage) without stopping the shared container.
 */
export interface TcpProxy {
  readonly url: string;
  /** Drops every connection and stops accepting new ones. */
  cut(): Promise<void>;
}

export async function startProxy(target: URL): Promise<TcpProxy> {
  const sockets = new Set<Socket>();

  const server: Server = createServer((client) => {
    const upstream = connect(Number(target.port), target.hostname);

    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => socket.destroy());
    }

    client.pipe(upstream).pipe(client);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const { port } = server.address() as AddressInfo;
  const url = new URL(target.toString());

  url.hostname = '127.0.0.1';
  url.port = String(port);

  return {
    url: url.toString(),
    cut: async () => {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));

      for (const socket of sockets) socket.destroy();

      await closed;
    },
  };
}
