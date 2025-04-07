import cloud from '@lafjs/cloud'

export default async function (ctx: FunctionContext) {
  const db = cloud.database();
  const _ = db.command;

  // 获取setting中的配置信息
  let campuses = [], colours = [], areas = [];
  try {
    const setting = await db.collection('setting').doc('filter').get();
    if (setting?.data) {
      campuses = setting.data.campuses || [];
      colours = setting.data.colour || [];
      areas = setting.data.area || [];
    }
  } catch (error) {
    console.error('获取 Setting 配置时出错:', error);
  }

  // 当前时间和本月开始时间
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  // 主要查询条件
  const currentCatsQf = { 
    adopt: _.neq(1), 
    to_star: _.neq(true),
    missing: _.neq(true)
  };
  
  // 一次性查询所有基础数据，减少数据库连接次数
  const [
    numAllCats,
    numSterilized, 
    numAdopted, 
    numCurrentCats, 
    numMissing, 
    numDeceased,
    numCurrentSterilized,
    genderStats,
    monthStats
  ] = await Promise.all([
    db.collection('cat').count(),
    db.collection('cat').where({ sterilized: true }).count(),
    db.collection('cat').where({ adopt: 1 }).count(),
    db.collection('cat').where(currentCatsQf).count(),
    db.collection('cat').where({ missing: true }).count(),
    db.collection('cat').where({ to_star: true }).count(),
    db.collection('cat').where({ ...currentCatsQf, sterilized: true }).count(),
    getGenderStats(db),
    getMonthStats(db, monthStart, _)
  ]);

  // 同时查询校区和花色数据
  const [campusStats, colourStats, latestEvents] = await Promise.all([
    getCampusStats(db, campuses, areas, _),
    getColourStats(db, colours),
    getLatestEvents(db)
  ]);

  // 预计算的比率
  const totalCats = numAllCats.total;
  const sterilizationRate = calculateRate(numSterilized.total, totalCats);
  const currentSterilizationRate = calculateRate(numCurrentSterilized.total, numCurrentCats.total);
  const adoptionRate = calculateRate(numAdopted.total, totalCats);

  // 构建统计数据
  const stats = {
    basic: {
      total: totalCats,
      sterilized: numSterilized.total,
      missing: numMissing.total,
      adopted: numAdopted.total,
      deceased: numDeceased.total,
      current: numCurrentCats.total,
      currentSterilized: numCurrentSterilized.total
    },
    rates: {
      sterilization: sterilizationRate,
      currentSterilization: currentSterilizationRate,
      adoption: adoptionRate
    },
    gender: genderStats,
    month: monthStats,
    campus: campusStats,
    colour: colourStats,
    events: latestEvents
  };

  // 调试信息构建
  const debugInfo = buildDebugInfo(stats);

  return {
    success: true,
    data: stats,
    debug: debugInfo
  };
}

// 获取性别分布数据
async function getGenderStats(db) {
  const [numMale, numFemale, unknownCats] = await Promise.all([
    db.collection('cat').where({ gender: '公' }).count(),
    db.collection('cat').where({ gender: '母' }).count(),
    db.collection('cat').where({ gender: '未知' }).field({ name: 1 }).get()
  ]);
  
  const totalCats = numMale.total + numFemale.total + unknownCats.data.length;
  
  return {
    male: {
      count: numMale.total,
      rate: calculateRate(numMale.total, totalCats)
    },
    female: {
      count: numFemale.total,
      rate: calculateRate(numFemale.total, totalCats)
    },
    unknown: {
      count: unknownCats.data.length,
      rate: calculateRate(unknownCats.data.length, totalCats),
      cats: unknownCats.data.map(cat => cat.name || '未命名')
    }
  };
}

// 获取本月数据
async function getMonthStats(db, monthStart, _) {
  const [newCats, adopted, sterilized, missing, deceased] = await Promise.all([
    db.collection('cat').where({ create_time: _.gte(monthStart) }).count(),
    db.collection('cat').where({ adopt: 1, adopt_time: _.gte(monthStart) }).count(),
    db.collection('cat').where({ sterilized: true, sterilized_time: _.gte(monthStart) }).count(),
    db.collection('cat').where({ missing: true, missing_time: _.gte(monthStart) }).count(),
    db.collection('cat').where({ to_star: true, deceased_time: _.gte(monthStart) }).count()
  ]);
  
  return {
    newCats: newCats.total,
    adopted: adopted.total,
    sterilized: sterilized.total,
    missing: missing.total,
    deceased: deceased.total
  };
}

// 获取校区分布
async function getCampusStats(db, campuses, areas, _) {
  return Promise.all(
    campuses.map(async campus => {
      // 获取该校区下的所有区域
      const campusAreas = areas.filter(area => area.campus === campus);
      
      // 获取该校区统计
      const [total, sterilized] = await Promise.all([
        db.collection('cat').where({ campus }).count(),
        db.collection('cat').where({ campus, sterilized: true }).count()
      ]);
      
      // 获取区域统计（并行处理）
      const areaStats = await Promise.all(
        campusAreas.map(area => getAreaStats(db, area, _))
      );

      return {
        campus,
        count: total.total,
        sterilized: sterilized.total,
        sterilizationRate: calculateRate(sterilized.total, total.total),
        areas: areaStats
      };
    })
  );
}

// 获取单个区域统计
async function getAreaStats(db, area, _) {
  const areaName = area.name;
  const campus = area.campus;
  
  // 一次性获取区域内所有猫的详细信息
  const allCats = await db.collection('cat')
    .where({ campus, area: areaName })
    .field({
      sterilized: true,
      adopt: true,
      missing: true,
      to_star: true,
      sterilized_time: true,
      missing_time: true,
      deceased_time: true
    })
    .get();
  
  const cats = allCats.data;
  const total = cats.length;
  const sterilizedCats = cats.filter(cat => cat.sterilized);
  
  // 计算TNR指数
  const tnrData = calculateTNRIndex(cats, sterilizedCats);
  
  return {
    area: areaName,
    count: total,
    sterilized: sterilizedCats.length,
    sterilizationRate: calculateRate(sterilizedCats.length, total),
    tnrIndex: tnrData.index,
    tnrDetail: tnrData.detail
  };
}

// 获取花色分布
async function getColourStats(db, colours) {
  return Promise.all(
    colours.map(async colour => {
      const total = await db.collection('cat').where({ colour }).count();
      return {
        colour,
        count: total.total
      };
    })
  );
}

// TNR指数算法
function calculateTNRIndex(allCats, sterilizedCats) {
  const now = new Date();
  
  let Q = 0, A = 0, D = 0, M = 0;
  const nonAdoptedCats = allCats.filter(cat => cat.adopt !== 1);
  
  // 统计已绝育猫的存活质量Q和领养A
  sterilizedCats.forEach(cat => {
    // 存活质量计算
    let survivalScore = 0;
    if (cat.sterilized_time) {
      const endTime = cat.missing ? cat.missing_time : 
                     (cat.to_star ? cat.deceased_time : now);
      const sterilizedDate = new Date(cat.sterilized_time);
      const endDate = new Date(endTime || now);
      const days = Math.floor((endDate - sterilizedDate) / (1000 * 60 * 60 * 24));
      survivalScore = Math.min(days / 365, 1);
    } else {
      survivalScore = (!cat.missing && !cat.to_star && !cat.adopt) ? 1 : 0;
    }
    Q += survivalScore;

    // 计数已绝育被领养猫
    if (cat.adopt === 1) {
      A++;
    }
  });
  
  // 统计所有未领养猫中的D和M
  nonAdoptedCats.forEach(cat => {
    if (cat.to_star === true) {
      D++; // 去世猫数
    } else if (cat.missing === true) {
      M++; // 失踪猫数
    }
  });

  const totalCats = allCats.length;
  const validCount = Math.max(sterilizedCats.length, 1);
  const totalNonAdoptedCount = Math.max(nonAdoptedCats.length, 1);
  
  // 计算各项指标
  const S = sterilizedCats.length / Math.max(totalCats, 1);
  const survivalRate = 1 - D/totalNonAdoptedCount;
  const registrationRate = 1 - M/totalNonAdoptedCount;
  const adoptionRate = 1- nonAdoptedCats.length / Math.max(totalCats, 1);
  
  // 如果所有绝育猫都被领养了，将存活质量设为最高值
  if (A === sterilizedCats.length && A > 0) {
    Q = sterilizedCats.length;
  }
  
  // 分段计算得分
  const baseScore = S * 40;
  const qualityScore = (
    Q/validCount * 0.4 + 
    adoptionRate * 0.3 + 
    survivalRate * 0.2 + 
    registrationRate * 0.1
  ) * 60;
  
  const finalScore = Math.min(Math.round(baseScore + qualityScore), 100);
  
  return {
    index: finalScore,
    detail: {
      sterilization_rate: S.toFixed(2),
      survival_quality: (Q/validCount).toFixed(2),
      adoption_rate: adoptionRate.toFixed(2),
      survival_rate: survivalRate.toFixed(2),
      registration_rate: registrationRate.toFixed(2),
      base_score: Math.round(baseScore),
      quality_score: Math.round(qualityScore)
    }
  };
}

// 获取最新事件
async function getLatestEvents(db) {
  // 使用聚合管道合并查询
  const eventQueries = [
    { type: '新猫', time_field: 'create_time', condition: { create_time: db.command.exists(true) } },
    { type: '绝育', time_field: 'sterilized_time', condition: { sterilized: true, sterilized_time: db.command.exists(true) } },
    { type: '领养', time_field: 'adopt_time', condition: { adopt: 1, adopt_time: db.command.exists(true) } },
    { type: '失踪', time_field: 'missing_time', condition: { missing: true, missing_time: db.command.exists(true) } },
    { type: '喵星', time_field: 'deceased_time', condition: { to_star: true, deceased_time: db.command.exists(true) } }
  ];
  
  // 并行获取每种事件类型的最新5条
  const eventResults = await Promise.all(
    eventQueries.map(query => 
      db.collection('cat')
        .where(query.condition)
        .field({ name: 1, _id: 1, [query.time_field]: 1 })
        .orderBy(query.time_field, 'desc')
        .limit(5)
        .get()
        .then(res => res.data.map(cat => ({
          type: query.type,
          date: formatDate(cat[query.time_field]),
          timestamp: cat[query.time_field],
          name: cat.name,
          id: cat._id
        })))
    )
  );
  
  // 合并并排序所有事件
  return [].concat(...eventResults)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, 10);
}

// 计算比率
function calculateRate(numerator, denominator) {
  return denominator > 0 ? parseFloat((numerator / denominator * 100).toFixed(1)) : 0;
}

// 格式化日期
function formatDate(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  
  if (diffMins < 60) return `${diffMins}分钟前`;
  if (diffHours < 24) return `${diffHours}小时前`;
  if (diffDays < 7) return `${diffDays}天前`;
  return `${date.getFullYear()}年${(date.getMonth() + 1)}月${date.getDate()}日`;
}

// 构建调试信息对象
function buildDebugInfo(stats) {
  return {
    "总猫数": `${stats.basic.total}只`,
    "已绝育": `${stats.basic.sterilized}只 (${stats.rates.sterilization}%)`,
    "已领养": `${stats.basic.adopted}只 (${stats.rates.adoption}%)`,
    "已失踪": `${stats.basic.missing}只`,
    "去喵星": `${stats.basic.deceased}只`,
    "现存猫数": `${stats.basic.current}只`,
    "现存已绝育": `${stats.basic.currentSterilized}只 (${stats.rates.currentSterilization}%)`,
    
    "公猫数量": `${stats.gender.male.count}只 (${stats.gender.male.rate}%)`,
    "母猫数量": `${stats.gender.female.count}只 (${stats.gender.female.rate}%)`,
    "未知性别": `${stats.gender.unknown.count}只 (${stats.gender.unknown.rate}%)\n具体猫猫：${stats.gender.unknown.cats.join('、')}`,
    
    "本月新增": `${stats.month.newCats}只`,
    "本月领养": `${stats.month.adopted}只`,
    "本月绝育": `${stats.month.sterilized}只`,
    "本月失踪": `${stats.month.missing}只`,
    "本月去喵星": `${stats.month.deceased}只`,
    
    "校区分布": stats.campus.map(campus => 
      `${campus.campus}: ${campus.count}只 (绝育率${campus.sterilizationRate}%)\n` +
      campus.areas.map(area => 
        `  - ${area.area}: ${area.count}只 (绝育率${area.sterilizationRate}%)\n` +
        `    TNR指数: ${area.tnrIndex} [S:${area.tnrDetail.sterilization_rate}, Q:${area.tnrDetail.survival_quality}, A:${area.tnrDetail.adoption_rate}, D:${area.tnrDetail.survival_rate}, M:${area.tnrDetail.registration_rate}]`
      ).join('\n')
    ).join('\n\n'),
    
    "花色分布": stats.colour.map(item => 
      `${item.colour}: ${item.count}只`
    ).join('\n'),
    
    "最新事件": stats.events.map(event => 
      `${event.date} - ${event.type}: ${event.name}`
    ).join('\n')
  };
} 