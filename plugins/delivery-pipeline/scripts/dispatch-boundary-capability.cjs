'use strict';

// This identity is shared only by the canonical policy and dispatch boundary.
// It keeps receipt trust injection out of the public resolver contract: a
// caller-supplied `receiptVerifier` without this capability is never accepted.
module.exports = Symbol('adr-014.dispatch-boundary');
