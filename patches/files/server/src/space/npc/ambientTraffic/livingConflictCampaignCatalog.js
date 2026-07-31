"use strict";

// These are deliberately compact fronts rather than whole-region spawn grids.
// Flights travel the same gate paths as players, while the economy can source
// their supplies from every representative station in the surrounding regions.
const CAMPAIGNS = Object.freeze([
  Object.freeze({
    campaignID: "tama_border_pressure",
    name: "Tama Border Pressure",
    theater: "Lonetrek / Black Rise border",
    intensity: 0.85,
    routeID: "campaign_nourvukaiken_tama",
    systemIDs: Object.freeze([30001376, 30002813]),
    endpointStationIDs: Object.freeze([60000376, 60005203]),
    riskBand: "lowsec",
    routeClass: "frontier",
    lowSecurity: true,
  }),
  Object.freeze({
    campaignID: "lonetrek_guristas_insurgency",
    name: "Lonetrek Guristas Insurgency",
    theater: "Sobaseki–Hakonen corridor",
    intensity: 0.65,
    routeID: "campaign_sobaseki_hakonen",
    systemIDs: Object.freeze([
      30001363,
      30001364,
      30001365,
      30001366,
      30001367,
      30001443,
      30001444,
      30001446,
      30001448,
    ]),
    endpointStationIDs: Object.freeze([60003925, 60003808]),
    riskBand: "lowsec",
    routeClass: "frontier",
    lowSecurity: true,
  }),
  Object.freeze({
    campaignID: "black_rise_supply_war",
    name: "Black Rise Supply War",
    theater: "Tama–Enaluri corridor",
    intensity: 1,
    routeID: "campaign_tama_enaluri",
    systemIDs: Object.freeze([
      30002813,
      30045346,
      30045345,
      30045353,
      30045338,
      30045344,
      30045339,
    ]),
    endpointStationIDs: Object.freeze([60005203, 60015068]),
    riskBand: "lowsec",
    routeClass: "frontier",
    lowSecurity: true,
  }),
]);

const BY_ID = new Map(CAMPAIGNS.map((campaign) => [campaign.campaignID, campaign]));

const ROUTE_SPECS = Object.freeze(CAMPAIGNS.map((campaign) => Object.freeze({
  routeID: campaign.routeID,
  systemIDs: campaign.systemIDs,
  endpointStationIDs: campaign.endpointStationIDs,
  riskBand: campaign.riskBand,
  routeClass: campaign.routeClass,
  lowSecurity: campaign.lowSecurity,
  campaignID: campaign.campaignID,
  campaignName: campaign.name,
  campaignIntensity: campaign.intensity,
  theater: campaign.theater,
})));

function getCampaign(campaignID) {
  return BY_ID.get(String(campaignID || "")) || null;
}

module.exports = {
  CAMPAIGNS,
  ROUTE_SPECS,
  getCampaign,
};
