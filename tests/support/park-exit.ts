// park-exit.ts - closes a connection so its worker is parked; the process must still exit.
import { Channel } from '../../src/channel.ts';

const channel = new Channel(new URL('./fake-worker.ts', import.meta.url));
await channel.call('query', { sql: 'echo', params: [] });
await channel.close();
process.stdout.write('parked\n');
