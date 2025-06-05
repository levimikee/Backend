// config/index.js

const columnMappings = {
  // — Datos “básicos” del propietario
  address:            0,   // A
  unitNumber:         1,   // B
  city:               2,   // C
  state:              3,   // D
  zip:                4,   // E
  county:             5,   // F
  apn:                6,   // G

  ownerOccupied:      7,   // H
  ownerOneFirstName:  8,   // I
  ownerOneLastName:   9,   // J
  ownerTwoFirstName: 10,   // K
  ownerTwoLastName:  11,   // L

  mailingCareOf:     12,   // M
  mailingAddress:    13,   // N
  mailingUnitNumber: 14,   // O
  mailingCity:       15,   // P
  mailingState:      16,   // Q
  mailingZip:        17,   // R
  mailingCounty:     18,   // S
  doNotMail:         19,   // T
  propertyType:      20,   // U
  bedrooms:          21,   // V
  totalBathrooms:    22,   // W
  buildingSqft:      23,   // X
  lotSizeSqft:       24,   // Y
  effectiveYearBuilt:25,  // Z
  totalAssessedValue:26,  // AA
  lastSaleDate:      27,   // AB
  lastSaleAmount:    28,   // AC
  totalOpenLoans:    29,   // AD
  estRemainingLoan:  30,   // AE
  estValue:          31,   // AF
  estLTV:            32,   // AG
  estEquity:         33,   // AH
  mlsStatus:         34,   // AI
  mlsDate:           35,   // AJ
  mlsAmount:         36,   // AK
  lienAmount:        37,   // AL
  marketingLists:    38,   // AM
  dateAddedToList:   39,   // AN
  unused40:          40,   // AO

  // — Teléfonos del propietario
  ownerMobile1:      41,   // AP
  ownerMobile1Type:  42,   // AQ
  ownerMobile2:      43,   // AR
  ownerMobile2Type:  44,   // AS
  ownerMobile3:      45,   // AT
  ownerMobile3Type:  46,   // AU
  ownerMobile4:      47,   // AV
  ownerMobile4Type:  48,   // AW
  ownerMobile5:      49,   // AX
  ownerMobile5Type:  50,   // AY
  ownerMobile6:      51,   // AZ
  ownerMobile6Type:  52,   // BA
  ownerMobile7:      53,   // BB
  ownerMobile7Type:  54,   // BC

  // — Teléfonos fijos y otros (no todos los usarás)
  ownerLandline1:    55,   // BD
  ownerLandline2:    56,   // BE
  ownerLandline3:    57,   // BF
  ownerLandline4:    58,   // BG
  ownerLandline5:    59,   // BH
  ownerLandline6:    60,   // BI
  ownerVoip1:        61,   // BJ
  ownerVoip2:        62,   // BK
  ownerVoip3:        63,   // BL
  ownerVoip4:        64,   // BM
  ownerPager1:       65,   // BN
  ownerSpecial1:     66,   // BO
  ownerUnknown1:     67,   // BP

  // — Parientes
  relative1Name:     68,   // BQ
  relative1Contact1: 69,   // BR
  relative1Contact2: 70,   // BS
  relative1Contact3: 71,   // BT
  relative1Contact4: 72,   // BU
  relative1Contact5: 73,   // BV

  relative2Name:     74,   // BW
  relative2Contact1: 75,   // BX
  relative2Contact2: 76,   // BY
  relative2Contact3: 77,   // BZ
  relative2Contact4: 78,   // CA
  relative2Contact5: 79,   // CB

  relative3Name:     80,   // CC
  relative3Contact1: 81,   // CD
  relative3Contact2: 82,   // CE
  relative3Contact3: 83,   // CF
  relative3Contact4: 84,   // CG
  relative3Contact5: 85,   // CH

  relative4Name:     86,   // CI
  relative4Contact1: 87,   // CJ
  relative4Contact2: 88,   // CK
  relative4Contact3: 89,   // CL
  relative4Contact4: 90,   // CM
  relative4Contact5: 91,   // CN

  relative5Name:     92,   // CO
  relative5Contact1: 93,   // CP
  relative5Contact2: 94,   // CQ
  relative5Contact3: 95,   // CR
  relative5Contact4: 96,   // CS
  relative5Contact5: 97,   // CT

  // — Emails
  emailAll:          98,   // CU
  email1:            99,   // CV
  email2:           100,   // CW
  email3:           101    // CX
};

const maximumParallelLoops = 10;
const maximumRelativesToCrawl = 5;

module.exports = { columnMappings, maximumParallelLoops, maximumRelativesToCrawl };