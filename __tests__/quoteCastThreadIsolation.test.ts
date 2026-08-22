import fs from 'node:fs';
import path from 'node:path';

describe('quote-cast thread isolation', () => {
  it('keeps quoted replies ancestry-blind while retaining the quoted PFP', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'components/SocialFeed/content/QuoteCast.tsx'),
      'utf8',
    );

    expect(source).toContain('<CachedAvatar');
    expect(source).not.toContain('ParentContextLine');
    expect(source).not.toContain('parentHash');
    expect(source).not.toContain('threadConnector');
  });
});
