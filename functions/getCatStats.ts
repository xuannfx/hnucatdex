import cloud from '@lafjs/cloud'

export default async function (ctx: FunctionContext) {
  const db = cloud.database();
  const _ = db.command;

  // 获取setting中的配置信息
  let campuses = [];
  let colours = [];
  let areas = [];
  try {
    // 从filter文档获取配置信息
    const setting = await db.collection('setting').doc('filter').get();
    if (setting && setting.data) {
      campuses = setting.data.campuses || [];
      colours = setting.data.colour || [];
      areas = setting.data.area || [];
      console.log('成功获取到 Setting 配置:', { campuses, colours, areas: areas.length });
    } else {
      console.error('未能获取到 Setting 配置，或配置数据为空，文档 ID: filter');
    }
  } catch (error) {
    console.error('获取 Setting 配置时出错:', error);
    // 即使出错，也保持 campuses/colours/areas 为空数组，让后续逻辑不崩溃
  }

  // 构建查询条件
  const allCatQf = {}; // 所有猫猫
  const sterilizedQf = { sterilized: true }; // 所有绝育量
  const adoptQf = { adopt: 1 }; // 所有领养
  const currentCatsQf = { 
    adopt: _.neq(1), 
    to_star: _.neq(true),
    missing: _.neq(true)
  }; // 现存猫猫（去除已领养、失踪、去喵星）

  // 使用count()方法获取各项数据
  let [numAllCats, numSterilized, numAdopted, numCurrentCats, numMissing, numDeceased] = await Promise.all([
    db.collection('cat').where(allCatQf).count(),
    db.collection('cat').where(sterilizedQf).count(),
    db.collection('cat').where(adoptQf).count(),
    db.collection('cat').where(currentCatsQf).count(),
    db.collection('cat').where({ missing: true }).count(),
    db.collection('cat').where({ to_star: true }).count()
  ]);

  // 获取现存绝育量
  const currentSterilizedQf = {
    ...currentCatsQf,
    sterilized: true
  };
  const numCurrentSterilized = await db.collection('cat').where(currentSterilizedQf).count();

  // 获取性别分布
  const [numMale, numFemale, numUnknown, unknownCats] = await Promise.all([
    db.collection('cat').where({ gender: '公' }).count(),
    db.collection('cat').where({ gender: '母' }).count(),
    db.collection('cat').where({ gender: '未知' }).count(),
    db.collection('cat').where({ gender: '未知' }).get()
  ]);

  // 获取本月数据
  const now = new Date();
  const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthStart = firstDayOfMonth.toISOString();
  
  const [monthNewCats, monthAdopted, monthSterilized, monthMissing, monthDeceased] = await Promise.all([
    db.collection('cat').where({
      create_time: _.gte(monthStart)
    }).count(),
    db.collection('cat').where({
      adopt: 1,
      adopt_time: _.gte(monthStart)
    }).count(),
    db.collection('cat').where({
      sterilized: true,
      sterilized_time: _.gte(monthStart)
    }).count(),
    db.collection('cat').where({
      missing: true,
      missing_time: _.gte(monthStart)
    }).count(),
    db.collection('cat').where({
      to_star: true,
      deceased_time: _.gte(monthStart)
    }).count()
  ]);

  // 获取校区分布
  const campusStats = await Promise.all(
    campuses.map(async campus => {
      // 获取该校区下的所有区域
      const campusAreas = areas.filter(area => area.campus === campus);
      
      // 获取该校区下的区域统计
      const areaStats = await Promise.all(
        campusAreas.map(async area => {
          const [total, sterilized] = await Promise.all([
            db.collection('cat').where({ 
              campus: area.campus,
              area: area.name 
            }).count(),
            db.collection('cat').where({ 
              campus: area.campus,
              area: area.name,
              sterilized: true 
            }).count()
          ]);
          return {
            area: area.name,
            count: total.total,
            sterilized: sterilized.total,
            sterilizationRate: total.total > 0 ? (sterilized.total / total.total * 100).toFixed(1) : 0
          };
        })
      );

      // 获取该校区的总体统计
      const [total, sterilized] = await Promise.all([
        db.collection('cat').where({ campus }).count(),
        db.collection('cat').where({ campus, sterilized: true }).count()
      ]);

      return {
        campus,
        count: total.total,
        sterilized: sterilized.total,
        sterilizationRate: total.total > 0 ? (sterilized.total / total.total * 100).toFixed(1) : 0,
        areas: areaStats
      };
    })
  );

  // 获取花色分布
  const colourStats = await Promise.all(
    colours.map(async colour => {
      const [total, sterilized] = await Promise.all([
        db.collection('cat').where({ colour }).count(),
        db.collection('cat').where({ colour, sterilized: true }).count()
      ]);
      return {
        colour,
        count: total.total,
        sterilized: sterilized.total,
        sterilizationRate: total.total > 0 ? (sterilized.total / total.total * 100).toFixed(1) : 0
      };
    })
  );

  // 获取最新事件信息
  const latestEvents = await getLatestEvents(db);

  // 构建统计数据
  const stats = {
    // 基础数据
    totalCats: numAllCats.total,
    totalSterilized: numSterilized.total,
    totalMissing: numMissing.total,
    totalAdopted: numAdopted.total,
    totalDeceased: numDeceased.total,
    currentCats: numCurrentCats.total,
    currentSterilized: numCurrentSterilized.total,

    // 预先计算的比率和百分比
    sterilizationRate: numAllCats.total > 0 ? (numSterilized.total / numAllCats.total * 100).toFixed(1) : "0",
    sterilizationWidth: numAllCats.total > 0 ? (numSterilized.total / numAllCats.total * 100) : 0,
    currentSterilizationRate: numCurrentCats.total > 0 ? (numCurrentSterilized.total / numCurrentCats.total * 100).toFixed(1) : "0",
    currentSterilizationWidth: numCurrentCats.total > 0 ? (numCurrentSterilized.total / numCurrentCats.total * 100) : 0,
    adoptionRate: numAllCats.total > 0 ? (numAdopted.total / numAllCats.total * 100).toFixed(1) : "0",
    adoptionWidth: numAllCats.total > 0 ? (numAdopted.total / numAllCats.total * 100) : 0,

    // 性别分布
    genderStats: {
      male: {
        count: numMale.total,
        rate: numAllCats.total > 0 ? (numMale.total / numAllCats.total * 100).toFixed(1) : "0"
      },
      female: {
        count: numFemale.total,
        rate: numAllCats.total > 0 ? (numFemale.total / numAllCats.total * 100).toFixed(1) : "0"
      },
      unknown: {
        count: numUnknown.total,
        rate: numAllCats.total > 0 ? (numUnknown.total / numAllCats.total * 100).toFixed(1) : "0",
        cats: unknownCats.data.map(cat => cat.name || '未命名')
      }
    },

    // 本月数据
    monthStats: {
      newCats: monthNewCats.total,
      adopted: monthAdopted.total,
      sterilized: monthSterilized.total,
      missing: monthMissing.total,
      deceased: monthDeceased.total
    },

    // 校区分布（包含区域分布）
    campusStats,

    // 花色分布
    colourStats,

    // 最新事件信息
    latestEvents
  };

  // 添加调试信息
  const debugInfo = {
    "总猫数": `${stats.totalCats}只`,
    "已绝育": `${stats.totalSterilized}只 (${(stats.totalSterilized / stats.totalCats * 100).toFixed(1)}%)`,
    "已领养": `${stats.totalAdopted}只 (${(stats.totalAdopted / stats.totalCats * 100).toFixed(1)}%)`,
    "已失踪": `${stats.totalMissing}只`,
    "去喵星": `${stats.totalDeceased}只`,
    "现存猫数": `${stats.currentCats}只`,
    "现存已绝育": `${stats.currentSterilized}只 (${stats.currentCats > 0 ? (stats.currentSterilized / stats.currentCats * 100).toFixed(1) : 0}%)`,

    // 性别分布
    "公猫数量": `${stats.genderStats.male.count}只 (${stats.genderStats.male.rate}%)`,
    "母猫数量": `${stats.genderStats.female.count}只 (${stats.genderStats.female.rate}%)`,
    "未知性别": `${stats.genderStats.unknown.count}只 (${stats.genderStats.unknown.rate}%)\n` +
               `具体猫猫：${stats.genderStats.unknown.cats.join('、')}`,
    
    // 本月数据
    "本月新增": `${stats.monthStats.newCats}只`,
    "本月领养": `${stats.monthStats.adopted}只`,
    "本月绝育": `${stats.monthStats.sterilized}只`,
    "本月失踪": `${stats.monthStats.missing}只`,
    "本月去喵星": `${stats.monthStats.deceased}只`,
    
    // 校区分布（包含区域分布）
    "校区分布": stats.campusStats.map(campus => 
      `${campus.campus}: ${campus.count}只 (绝育率${campus.sterilizationRate}%)\n` +
      campus.areas.map(area => 
        `  - ${area.area}: ${area.count}只 (绝育率${area.sterilizationRate}%)`
      ).join('\n')
    ).join('\n\n'),

    // 花色分布
    "花色分布": stats.colourStats.map(item => 
      `${item.colour}: ${item.count}只 (绝育率${item.sterilizationRate}%)`
    ).join('\n'),

    // 最新事件信息
    "最新事件": stats.latestEvents.map(event => 
      `${event.date} - ${event.type}: ${event.name}`
    ).join('\n')
  };

  return {
    success: true,
    data: stats,
    debug: debugInfo
  };
}

// 获取最新事件（新猫、绝育、领养、失踪、去世）
async function getLatestEvents(db) {
  // 获取最近的事件（每种类型取前5个）
  const [recentNewCats, recentSterilized, recentAdopted, recentMissing, recentDeceased] = await Promise.all([
    db.collection('cat')
      .where({ create_time: db.command.exists(true) })
      .orderBy('create_time', 'desc')
      .limit(5)
      .get(),
    db.collection('cat')
      .where({ sterilized: true, sterilized_time: db.command.exists(true) })
      .orderBy('sterilized_time', 'desc')
      .limit(5)
      .get(),
    db.collection('cat')
      .where({ adopt: 1, adopt_time: db.command.exists(true) })
      .orderBy('adopt_time', 'desc')
      .limit(5)
      .get(),
    db.collection('cat')
      .where({ missing: true, missing_time: db.command.exists(true) })
      .orderBy('missing_time', 'desc')
      .limit(5)
      .get(),
    db.collection('cat')
      .where({ to_star: true, deceased_time: db.command.exists(true) })
      .orderBy('deceased_time', 'desc')
      .limit(5)
      .get()
  ]);
  
  // 合并所有事件并按时间排序
  const allEvents = [
    ...recentNewCats.data.map(cat => ({
      type: '新猫',
      date: formatDate(cat.create_time),
      timestamp: cat.create_time,
      name: cat.name,
      id: cat._id
    })),
    ...recentSterilized.data.map(cat => ({
      type: '绝育',
      date: formatDate(cat.sterilized_time),
      timestamp: cat.sterilized_time,
      name: cat.name,
      id: cat._id
    })),
    ...recentAdopted.data.map(cat => ({
      type: '领养',
      date: formatDate(cat.adopt_time),
      timestamp: cat.adopt_time,
      name: cat.name,
      id: cat._id
    })),
    ...recentMissing.data.map(cat => ({
      type: '失踪',
      date: formatDate(cat.missing_time),
      timestamp: cat.missing_time,
      name: cat.name,
      id: cat._id
    })),
    ...recentDeceased.data.map(cat => ({
      type: '去往喵星',
      date: formatDate(cat.deceased_time),
      timestamp: cat.deceased_time,
      name: cat.name,
      id: cat._id
    }))
  ];
  
  // 按时间倒序排序
  return allEvents
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, 10); // 只取前10个最新事件
}

// 格式化日期为更友好的中文格式
function formatDate(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  
  // 计算时间距离现在的差异
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  
  // 根据时间差显示不同格式
  if (diffMins < 60) {
    return `${diffMins}分钟前`;
  } else if (diffHours < 24) {
    return `${diffHours}小时前`;
  } else if (diffDays < 7) {
    return `${diffDays}天前`;
  } else {
    // 超过7天显示具体日期
    return `${date.getFullYear()}年${(date.getMonth() + 1)}月${date.getDate()}日`;
  }
} 