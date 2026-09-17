import test from 'node:test';
import assert from 'node:assert/strict';

import '../lib/paths.js';
import '../lib/sakai.js';
const Sakai = globalThis.LUMS.sakai;

const SITE = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';
const ORIGIN = 'https://lms.lums.edu.pk';
const page = (...tools) => ({ id: 'page', tools });

test('finds the Resources placement among other pages', () => {
  const pages = [
    page({ id: 'p-overview', toolId: 'sakai.synoptic.messagecenter' }),
    page({ id: 'p-res', toolId: 'sakai.resources' })
  ];
  assert.equal(
    Sakai.resourcesUrlFromPages(pages, SITE, ORIGIN),
    ORIGIN + '/portal/site/' + SITE + '/tool/p-res'
  );
});

test('accepts the wrapped collection shape', () => {
  const pages = { sitepage_collection: [page({ id: 'p-res', toolId: 'sakai.resources' })] };
  assert.match(Sakai.resourcesUrlFromPages(pages, SITE, ORIGIN), /\/tool\/p-res$/);
});

test('a course without Resources gives null', () => {
  assert.equal(Sakai.resourcesUrlFromPages([page({ id: 'x', toolId: 'sakai.announcements' })], SITE, ORIGIN), null);
  assert.equal(Sakai.resourcesUrlFromPages(null, SITE, ORIGIN), null);
});
