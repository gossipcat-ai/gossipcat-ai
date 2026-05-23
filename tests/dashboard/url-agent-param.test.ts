/**
 * Pure helpers for the ?agent= URL query param. The setter side has a
 * side-effect (history.pushState + dispatchEvent) which we stub.
 */

import {
  getAgentParam,
  buildUrlWithAgent,
} from '../../packages/dashboard-v2/src/lib/url-agent-param';

describe('getAgentParam', () => {
  it('returns null when ?agent= is absent', () => {
    expect(getAgentParam('')).toBeNull();
    expect(getAgentParam('?')).toBeNull();
    expect(getAgentParam('?other=x')).toBeNull();
    expect(getAgentParam('?graph=1')).toBeNull();
  });
  it('returns the agent id when present', () => {
    expect(getAgentParam('?agent=opus-implementer')).toBe('opus-implementer');
    expect(getAgentParam('?graph=1&agent=sonnet-reviewer')).toBe('sonnet-reviewer');
    expect(getAgentParam('?agent=foo&other=bar')).toBe('foo');
  });
  it('returns null for an empty value', () => {
    expect(getAgentParam('?agent=')).toBeNull();
  });
});

describe('buildUrlWithAgent', () => {
  it('adds ?agent=ID when none present', () => {
    expect(buildUrlWithAgent('/dashboard/', '', 'opus-implementer'))
      .toBe('/dashboard/?agent=opus-implementer');
  });
  it('preserves existing other params', () => {
    expect(buildUrlWithAgent('/dashboard/', '?graph=1', 'opus-implementer'))
      .toBe('/dashboard/?graph=1&agent=opus-implementer');
  });
  it('replaces an existing agent param', () => {
    expect(buildUrlWithAgent('/dashboard/', '?agent=old&graph=1', 'new'))
      .toBe('/dashboard/?agent=new&graph=1');
  });
  it('removes the param when id is null', () => {
    expect(buildUrlWithAgent('/dashboard/', '?agent=opus-implementer&graph=1', null))
      .toBe('/dashboard/?graph=1');
  });
  it('returns the pathname alone when removing the last param', () => {
    expect(buildUrlWithAgent('/dashboard/', '?agent=opus-implementer', null))
      .toBe('/dashboard/');
  });
});
