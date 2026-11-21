import { dedupe, type JobQueue } from '@noctcore/jobs';

type Jobs = {
  receipt: { orderId: string };
  'reindex-user': { userId: string };
  digest: { userId: string };
  'audit-export': { requestId: string };
};

export async function examples(queue: JobQueue<Jobs>, orderId: string, userId: string, requestId: string) {
  // One receipt per order per day, even after the first one finished.
  await queue.add('receipt', { orderId }, { dedupe: dedupe.window(['receipt', orderId], '1d') });

  // At most one reindex per user waiting or running; once it settles, the next is a new job.
  await queue.add('reindex-user', { userId }, { dedupe: dedupe.until(['reindex', userId]) });

  // A burst of edits becomes one digest, built from the last payload, 30 s after the last edit.
  await queue.add('digest', { userId }, { dedupe: dedupe.debounce(['digest', userId], '30s') });

  // Every call is a new job, said out loud.
  await queue.add('audit-export', { requestId }, { dedupe: dedupe.none() });

  // A deliberate resend: end the window early, then add again.
  await queue.releaseDedupe(['receipt', orderId]);
}
