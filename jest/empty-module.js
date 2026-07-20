// Empty stub for ESM-only markdown deps that quorum-shared uses lazily.
// The crypto/auth tests never invoke shared's markdown code paths, so an
// empty module is safe and avoids transforming a large ESM markdown chain.
module.exports = {};
