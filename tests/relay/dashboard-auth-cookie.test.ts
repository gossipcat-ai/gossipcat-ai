import { isRequestSecure, buildSessionCookie } from '@gossip/relay/dashboard/routes';
import { IncomingMessage } from 'http';

function mockReq(opts: { encrypted?: boolean; headers?: Record<string, string | string[]> }): IncomingMessage {
  return {
    socket: opts.encrypted === undefined ? {} : { encrypted: opts.encrypted },
    headers: opts.headers ?? {},
  } as unknown as IncomingMessage;
}

describe('isRequestSecure (issue #548 item 1)', () => {
  it('returns true when the socket is a TLSSocket (encrypted)', () => {
    expect(isRequestSecure(mockReq({ encrypted: true }))).toBe(true);
  });

  it('returns false on a plain HTTP socket', () => {
    expect(isRequestSecure(mockReq({ encrypted: false }))).toBe(false);
  });

  it('returns false when there is no encrypted flag and no forwarded header', () => {
    expect(isRequestSecure(mockReq({}))).toBe(false);
  });

  it('honors x-forwarded-proto: https', () => {
    expect(isRequestSecure(mockReq({ headers: { 'x-forwarded-proto': 'https' } }))).toBe(true);
  });

  it('treats x-forwarded-proto: http as insecure', () => {
    expect(isRequestSecure(mockReq({ headers: { 'x-forwarded-proto': 'http' } }))).toBe(false);
  });

  it('reads the first proto in a comma-joined forwarded header', () => {
    expect(isRequestSecure(mockReq({ headers: { 'x-forwarded-proto': 'https, http' } }))).toBe(true);
    expect(isRequestSecure(mockReq({ headers: { 'x-forwarded-proto': 'http, https' } }))).toBe(false);
  });

  it('reads the first value of an array forwarded header', () => {
    expect(isRequestSecure(mockReq({ headers: { 'x-forwarded-proto': ['https', 'http'] } }))).toBe(true);
  });
});

describe('buildSessionCookie (issue #548 item 1)', () => {
  it('omits Secure over plain HTTP so the browser actually stores the cookie', () => {
    const cookie = buildSessionCookie('tok123', false);
    expect(cookie).not.toMatch(/;\s*Secure/);
    expect(cookie).toContain('dashboard_session=tok123');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/dashboard');
    expect(cookie).toContain('Max-Age=86400');
  });

  it('includes Secure when served over TLS', () => {
    const cookie = buildSessionCookie('tok123', true);
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
  });
});
