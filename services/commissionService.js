// Runtime in-memory commission tracker for workforce earnings
const runtimeCommissions = [];

function getCommissions() {
  return runtimeCommissions;
}

function addCommission(commission) {
  if (!commission) return;
  runtimeCommissions.unshift(commission);
}

function findCommission(predicate) {
  return runtimeCommissions.find(predicate);
}

function filterCommissions(predicate) {
  return runtimeCommissions.filter(predicate);
}

module.exports = {
  runtimeCommissions,
  getCommissions,
  addCommission,
  findCommission,
  filterCommissions
};
