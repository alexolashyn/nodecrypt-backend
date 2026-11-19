import { keyPrefix } from './redis.service';

describe('keyPrefix', () => {
  it.each([
    ['nonce:8fK2xQp9LmZ3vR7tA', 'nonce'],
    ['refresh:Zm9vYmFyYmF6', 'refresh'],
    ['nc:throttle:AuthController.verify:1.2.3.4', 'nc:throttle'],
    ['nc:lock:file:0xabc:0xdef', 'nc:lock'],
    ['nc:uploads:global', 'nc:uploads'],
    ['nc:cid:bafy:refs', 'nc:cid'],
    ['keepalive', 'keepalive'],
  ])('reduces %s to %s', (key, prefix) => {
    expect(keyPrefix(key)).toBe(prefix);
  });

  it('never exposes the secret part of a key', () => {
    expect(keyPrefix('refresh:secret-token')).not.toContain('secret');
  });
});
