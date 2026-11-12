import { EmbedAuthErrorCode, request } from 'librechat-data-provider';
import { act, fireEvent, render, screen } from '@testing-library/react';
import SignIn from '../SignIn';

const mockExchange = jest.fn();

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/data-provider', () => ({
  useEmbedExchangeMutation: () => ({ mutateAsync: mockExchange }),
}));

jest.mock('../pkce', () => ({
  createCodeVerifier: () => 'v'.repeat(43),
  createCodeChallenge: async () => 'c'.repeat(64),
}));

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};

/** Advances past one poll interval and lets the exchange promise settle. */
const nextPoll = async () => {
  await act(async () => {
    jest.advanceTimersByTime(1500);
  });
  await flush();
  await flush();
};

describe('Embed SignIn', () => {
  let popup: { location: { href: string } };
  let openSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    mockExchange.mockReset();
    popup = { location: { href: '' } };
    openSpy = jest.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
  });

  afterEach(() => {
    openSpy.mockRestore();
    jest.useRealTimers();
  });

  it('tells the viewer when the browser blocks the sign-in window', async () => {
    openSpy.mockReturnValue(null);
    render(<SignIn />);
    fireEvent.click(screen.getByRole('button', { name: 'com_embed_sign_in' }));
    await flush();
    expect(screen.getByRole('alert')).toHaveTextContent('com_embed_popup_blocked');
    expect(mockExchange).not.toHaveBeenCalled();
  });

  it('sends the popup to the provider and signs in once the handoff arrives', async () => {
    const dispatch = jest.spyOn(request, 'dispatchTokenUpdatedEvent').mockImplementation(() => {});
    mockExchange
      .mockResolvedValueOnce({ code: EmbedAuthErrorCode.HANDOFF_PENDING })
      .mockResolvedValueOnce({ token: 'access-token', user: { id: 'u1' } });

    render(<SignIn />);
    fireEvent.click(screen.getByRole('button', { name: 'com_embed_sign_in' }));
    await flush();

    expect(popup.location.href).toContain(
      `/api/embed/oauth/openid?code_challenge=${'c'.repeat(64)}`,
    );
    expect(screen.getByRole('status')).toHaveTextContent('com_embed_waiting');
    expect(screen.getByRole('button', { name: 'com_embed_sign_in' })).toBeDisabled();

    await nextPoll();
    expect(dispatch).not.toHaveBeenCalled();
    await nextPoll();
    expect(mockExchange).toHaveBeenCalledWith('v'.repeat(43));
    expect(dispatch).toHaveBeenCalledWith('access-token');
    dispatch.mockRestore();
  });

  it('shows a retryable failure when the exchange errors', async () => {
    mockExchange.mockRejectedValueOnce(new Error('network'));
    render(<SignIn />);
    fireEvent.click(screen.getByRole('button', { name: 'com_embed_sign_in' }));
    await flush();
    await nextPoll();
    expect(screen.getByRole('alert')).toHaveTextContent('com_embed_sign_in_failed');
    expect(screen.getByRole('button', { name: 'com_embed_sign_in' })).toBeEnabled();
  });

  it('lets the viewer confirm sign-in, asking for storage access first', async () => {
    const dispatch = jest.spyOn(request, 'dispatchTokenUpdatedEvent').mockImplementation(() => {});
    const requestStorageAccess = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(document, 'requestStorageAccess', {
      configurable: true,
      value: requestStorageAccess,
    });
    mockExchange.mockResolvedValue({ token: 'access-token', user: { id: 'u1' } });

    render(<SignIn />);
    fireEvent.click(screen.getByRole('button', { name: 'com_embed_sign_in' }));
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'com_embed_signed_in_continue' }));
    await flush();
    await flush();

    expect(requestStorageAccess).toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith('access-token');
    dispatch.mockRestore();
    Reflect.deleteProperty(document, 'requestStorageAccess');
  });
});
