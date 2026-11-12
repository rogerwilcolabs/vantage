import { useEffect, useRef, useState } from 'react';
import { Button, Spinner } from '@librechat/client';
import { embedLoginStart, request } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';
import { createCodeChallenge, createCodeVerifier } from './pkce';
import { useEmbedExchangeMutation } from '~/data-provider';
import { useLocalize } from '~/hooks';

const POLL_INTERVAL_MS = 1500;
/** Matches the server's default handoff lifetime; a slower sign-in starts over. */
const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;
const POPUP_NAME = 'vantage-embed-sign-in';
const POPUP_FEATURES = 'popup,width=480,height=640';

type Status = 'idle' | 'waiting' | 'blocked' | 'timedOut' | 'failed';

const STATUS_MESSAGE: Partial<Record<Status, TranslationKeys>> = {
  waiting: 'com_embed_waiting',
  blocked: 'com_embed_popup_blocked',
  timedOut: 'com_embed_timed_out',
  failed: 'com_embed_sign_in_failed',
};

const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

/**
 * Signs the viewer in through a popup, since identity providers refuse to load inside frames.
 * The provider's pages cut the popup off from this frame, so the frame polls for the handoff
 * the popup leaves behind. "I've signed in" asks the browser for storage access first, which
 * browsers that block cross-site cookies (Safari) require before the handoff is visible here.
 */
export default function SignIn() {
  const localize = useLocalize();
  const { mutateAsync: exchange } = useEmbedExchangeMutation();
  const [status, setStatus] = useState<Status>('idle');
  /** The verifier of the sign-in in flight; clearing it stops that sign-in's polling. */
  const verifierRef = useRef<string | null>(null);

  useEffect(
    () => () => {
      verifierRef.current = null;
    },
    [],
  );

  /** One exchange attempt. Returns `true` once this sign-in is settled either way. */
  const tryExchange = async (verifier: string): Promise<boolean> => {
    try {
      const result = await exchange(verifier);
      if (verifierRef.current !== verifier) {
        return true;
      }
      if ('token' in result) {
        verifierRef.current = null;
        request.dispatchTokenUpdatedEvent(result.token);
        return true;
      }
      return false;
    } catch {
      if (verifierRef.current === verifier) {
        verifierRef.current = null;
        setStatus('failed');
      }
      return true;
    }
  };

  const pollForHandoff = async (verifier: string) => {
    const deadline = Date.now() + SIGN_IN_TIMEOUT_MS;
    while (verifierRef.current === verifier) {
      await wait(POLL_INTERVAL_MS);
      if (verifierRef.current !== verifier || (await tryExchange(verifier))) {
        return;
      }
      if (Date.now() > deadline) {
        verifierRef.current = null;
        setStatus('timedOut');
        return;
      }
    }
  };

  const signIn = async () => {
    /* Opened before any await, so the browser still counts it as a response to the click. */
    const popup = window.open('', POPUP_NAME, POPUP_FEATURES);
    if (!popup) {
      setStatus('blocked');
      return;
    }
    const verifier = createCodeVerifier();
    verifierRef.current = verifier;
    setStatus('waiting');
    const challenge = await createCodeChallenge(verifier);
    popup.location.href = new URL(embedLoginStart(challenge), window.location.origin).toString();
    void pollForHandoff(verifier);
  };

  const confirmSignedIn = async () => {
    const verifier = verifierRef.current;
    if (!verifier) {
      return;
    }
    if (typeof document.requestStorageAccess === 'function') {
      try {
        await document.requestStorageAccess();
      } catch {
        /* Denied or unavailable: the exchange below simply stays pending. */
      }
    }
    await tryExchange(verifier);
  };

  const message = STATUS_MESSAGE[status];
  const isWaiting = status === 'waiting';

  return (
    <main className="flex h-dvh items-center justify-center bg-presentation p-4 text-text-primary">
      <div className="flex w-full max-w-sm flex-col items-center gap-4 text-center">
        <h1 className="text-xl font-semibold">{localize('com_embed_sign_in_title')}</h1>
        <p className="text-sm text-text-secondary">{localize('com_embed_sign_in_description')}</p>
        <Button onClick={signIn} disabled={isWaiting} className="w-full">
          {isWaiting && <Spinner className="mr-2 size-4" aria-hidden="true" />}
          {localize('com_embed_sign_in')}
        </Button>
        {isWaiting && (
          <Button variant="outline" onClick={confirmSignedIn} className="w-full">
            {localize('com_embed_signed_in_continue')}
          </Button>
        )}
        <p
          role={status === 'waiting' ? 'status' : 'alert'}
          aria-live="polite"
          className="min-h-5 text-sm text-text-secondary"
        >
          {message != null ? localize(message) : ''}
        </p>
      </div>
    </main>
  );
}
