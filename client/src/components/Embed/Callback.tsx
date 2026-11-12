import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useLocalize } from '~/hooks';

const CLOSE_DELAY_MS = 800;

/**
 * Where the sign-in popup lands. The frame that opened it picks the session up on its own, so
 * this page only says what happened and tries to close itself. Browsers refuse `window.close()`
 * once the identity provider's pages have cut the popup off, so the message stays meaningful.
 */
export default function Callback() {
  const localize = useLocalize();
  const [searchParams] = useSearchParams();
  const failed = searchParams.has('error');

  useEffect(() => {
    if (failed) {
      return;
    }
    const timer = window.setTimeout(() => window.close(), CLOSE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [failed]);

  return (
    <main className="flex h-dvh items-center justify-center bg-presentation p-4 text-text-primary">
      <p role={failed ? 'alert' : 'status'} className="max-w-sm text-center text-sm">
        {localize(failed ? 'com_embed_callback_error' : 'com_embed_callback_success')}
      </p>
    </main>
  );
}
