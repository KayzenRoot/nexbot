import { useEffect, useState, type KeyboardEvent } from 'react';
import { LogIn, PlugZap, RefreshCw, Trash2 } from 'lucide-react';
import type { Connection } from '../shared/connection-types';
import { api } from './api';
import { useTranslation } from './i18n';
// Lives inside the Dot form, so it saves immediately through its own
// requests and keeps Enter from submitting the surrounding form.
const stayInSection = (event: KeyboardEvent) => {
  if (event.key === 'Enter') event.preventDefault();
};
export function ConnectionsSection({ dotId }: { dotId: string }) {
  const { t } = useTranslation();
  const [connections, setConnections] = useState<Connection[]>();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [waiting, setWaiting] = useState<string>();
  const [signInUrl, setSignInUrl] = useState<string>();
  // While the owner signs in in another tab, watch for the callback to land.
  useEffect(() => {
    if (!waiting) return;
    const started = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - started > 5 * 60_000) {
        setWaiting(undefined);
        return;
      }
      void api<Connection[]>(`/dots/${encodeURIComponent(dotId)}/connections`)
        .then((list) => {
          setConnections(list);
          if (list.find((item) => item.id === waiting)?.signedIn) {
            setWaiting(undefined);
            setSignInUrl(undefined);
          }
        })
        .catch(() => {});
    }, 2000);
    return () => clearInterval(timer);
  }, [waiting, dotId]);
  useEffect(() => {
    let active = true;
    void api<Connection[]>(`/dots/${encodeURIComponent(dotId)}/connections`)
      .then((value) => active && setConnections(value))
      .catch(
        (cause) =>
          active &&
          setError(
            cause instanceof Error
              ? cause.message
              : t('connections.loadFailed'),
          ),
      );
    return () => {
      active = false;
    };
  }, [dotId]);
  const run = async <T,>(key: string, request: () => Promise<T>) => {
    setBusy(key);
    setError('');
    try {
      return await request();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : t('connections.requestFailed'),
      );
    } finally {
      setBusy('');
    }
  };
  const replace = (next: Connection) =>
    setConnections((list) =>
      list?.map((item) => (item.id === next.id ? next : item)),
    );
  const signIn = async (connection: Connection) => {
    // Open the tab during the click so popup blockers allow it.
    const tab = window.open('about:blank', '_blank');
    const result = await run(connection.id, () =>
      api<{ authorizationUrl?: string; connection?: Connection }>(
        `/connections/${connection.id}/sign-in`,
        'POST',
        {},
      ),
    );
    if (!result || result.connection) {
      tab?.close();
      if (result?.connection) replace(result.connection);
      return;
    }
    const url = result.authorizationUrl!;
    if (tab) {
      tab.opener = null;
      tab.location.href = url;
    } else setSignInUrl(url);
    setWaiting(connection.id);
  };
  const add = async () => {
    const created = await run('add', () =>
      api<Connection>(
        `/dots/${encodeURIComponent(dotId)}/connections`,
        'POST',
        {
          name: name.trim(),
          url: url.trim(),
          ...(token.trim() ? { token: token.trim() } : {}),
        },
      ),
    );
    if (!created) return;
    setConnections((list) => [...(list ?? []), created]);
    setName('');
    setUrl('');
    setToken('');
  };
  return (
    <fieldset className="space-access-fields connections-fields">
      <legend>{t('connections.title')}</legend>
      <p className="muted">{t('connections.help')}</p>
      {connections?.map((connection) => (
        <div className="connection" key={connection.id}>
          <div className="connection-head">
            <PlugZap size={15} />
            <span>
              <strong>{connection.name}</strong>
              <small>
                {new URL(connection.url).host}
                {connection.hasToken ? t('connections.tokenSaved') : ''}
                {connection.authMode === 'oauth'
                  ? connection.signedIn
                    ? t('connections.signedIn')
                    : waiting === connection.id
                      ? t('connections.waitingSignIn')
                      : t('connections.needsSignIn')
                  : ''}
              </small>
            </span>
            {connection.authMode === 'oauth' && (
              <button
                type="button"
                className="connection-signin"
                disabled={!!busy}
                onClick={async () => {
                  if (!connection.signedIn) return void signIn(connection);
                  const next = await run(connection.id, () =>
                    api<Connection>(
                      `/connections/${connection.id}/sign-out`,
                      'POST',
                      {},
                    ),
                  );
                  if (next) replace(next);
                }}
              >
                {connection.signedIn ? (
                  t('connections.signOut')
                ) : (
                  <>
                    <LogIn size={13} /> {t('connections.signIn')}
                  </>
                )}
              </button>
            )}
            <button
              type="button"
              className="icon-button"
              aria-label={t('connections.refreshAria', {
                name: connection.name,
              })}
              disabled={!!busy}
              onClick={async () => {
                const next = await run(connection.id, () =>
                  api<Connection>(
                    `/connections/${connection.id}/refresh`,
                    'POST',
                    {},
                  ),
                );
                if (next) replace(next);
              }}
            >
              <RefreshCw size={15} />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label={t('connections.removeAria', {
                name: connection.name,
              })}
              disabled={!!busy}
              onClick={async () => {
                if (
                  !window.confirm(
                    t('connections.removeConfirm', { name: connection.name }),
                  )
                )
                  return;
                const done = await run(connection.id, () =>
                  api(`/connections/${connection.id}`, 'DELETE'),
                );
                if (done)
                  setConnections((list) =>
                    list?.filter((item) => item.id !== connection.id),
                  );
              }}
            >
              <Trash2 size={15} />
            </button>
          </div>
          {connection.error && (
            <p className="chat-error" role="alert">
              {connection.error}
            </p>
          )}
          {waiting === connection.id && signInUrl && (
            <p className="muted">
              {t('connections.signInBlocked')}{' '}
              <a href={signInUrl} target="_blank" rel="noreferrer noopener">
                {t('connections.openSignIn')}
              </a>
            </p>
          )}
          {!connection.tools.length && (
            <p className="muted">
              {connection.authMode === 'oauth' && !connection.signedIn
                ? t('connections.signInToSeeTools')
                : t('connections.noTools')}
            </p>
          )}
          <ul className="connection-tools">
            {connection.tools.map((tool) => {
              const patch = async (value: {
                enabled?: boolean;
                requiresApproval?: boolean;
              }) => {
                const next = await run(connection.id, () =>
                  api<Connection>(
                    `/connections/${connection.id}/tools/${encodeURIComponent(tool.name)}`,
                    'PATCH',
                    value,
                  ),
                );
                if (next) replace(next);
              };
              return (
                <li key={tool.name}>
                  <label className="permission-row">
                    <input
                      type="checkbox"
                      checked={tool.enabled}
                      disabled={!!busy}
                      onChange={(event) =>
                        void patch({ enabled: event.target.checked })
                      }
                    />
                    <span>
                      <strong>
                        {tool.title}
                        {tool.readOnly && <em>{t('connections.readOnly')}</em>}
                      </strong>
                      {tool.description && <small>{tool.description}</small>}
                    </span>
                  </label>
                  <label className="connection-approval">
                    <input
                      type="checkbox"
                      checked={tool.requiresApproval}
                      disabled={!!busy || !tool.enabled}
                      onChange={(event) =>
                        void patch({ requiresApproval: event.target.checked })
                      }
                    />
                    {t('connections.askFirst')}
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      <div className="connection-add">
        <label className="field-label" htmlFor="connection-name">
          {t('connections.addTitle')}
        </label>
        <input
          id="connection-name"
          placeholder={t('connections.namePlaceholder')}
          maxLength={40}
          value={name}
          onKeyDown={stayInSection}
          onChange={(event) => setName(event.target.value)}
        />
        <input
          aria-label={t('connections.urlAria')}
          placeholder="https://example.com/mcp"
          type="url"
          value={url}
          onKeyDown={stayInSection}
          onChange={(event) => setUrl(event.target.value)}
        />
        <input
          aria-label={t('connections.tokenLabel')}
          placeholder={t('connections.tokenLabel')}
          type="password"
          autoComplete="off"
          value={token}
          onKeyDown={stayInSection}
          onChange={(event) => setToken(event.target.value)}
        />
        <button
          type="button"
          className="connection-connect"
          disabled={!!busy || !name.trim() || !url.trim()}
          onClick={() => void add()}
        >
          {busy === 'add'
            ? t('connections.connecting')
            : t('connections.connect')}
        </button>
      </div>
      {error && (
        <p className="chat-error" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}
