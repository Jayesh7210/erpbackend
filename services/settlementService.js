// Runtime settlement and FSM hub store
const runtimeSettlements = [];

const fsmSettlementHub = {
  depot_stock: 0,
  warehouse: {
    received: 0,
    allocated: 0,
    sold: 0,
    returned: 0,
    sold_value: 0
  },
  team_settlement: []
};

module.exports = {
  runtimeSettlements,
  fsmSettlementHub
};
