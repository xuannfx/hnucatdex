import {
  shuffle,
  regReplace,
  getDeltaHours,
  sleep,
  getCurrentPath
} from "../../utils/utils";
import {
  getAvatar,
  getVisitedDate
} from "../../utils/cat";
import {
  getCatCommentCount
} from "../../utils/comment";
import { getUserInfo } from "../../utils/user";
import cache from "../../utils/cache";
import config from "../../config";
import { loadFilter, getGlobalSettings, showTab } from "../../utils/page";
import { isManagerAsync, checkCanShowNews } from "../../utils/user";
import { cloud } from "../../utils/cloudAccess";

const default_png = undefined;

const tipInterval = 24; // 提示间隔时间 hours

// 分享的标语
const share_text = config.text.app_name + ' - ' + config.text.genealogy.share_tip;

Page({

  /**
   * 页面的初始数据
   */
  data: {
    cats: [],

    filters: [],
    filters_sub: 0, // 过滤器子菜单
    filters_legal: true, // 这组过滤器是否合法
    filters_show: false, // 是否显示过滤器
    filters_input: '', // 输入的内容，目前只用于挑选名字
    filters_show_shadow: false, // 滚动之后才显示阴影
    filters_empty: true, // 过滤器是否为空

    // 高度，单位为px（后面会覆盖掉）
    heights: {
      filters: 40,
    },
    // 总共有多少只猫
    catsMax: 0,

    // 加载相关
    loading: false, // 正在加载
    loadnomore: false, // 没有再多了

    // 领养状态
    adopt_desc: config.cat_status_adopt,
    // 寻找领养的按钮
    adopt_count: 0,

    // 广告是否展示
    ad_show: {},
    // 广告id
    ad: {},

    // 需要弹出的公告
    newsList: [],
    newsImage: "",

    text_cfg: config.text
  },

  jsData: {
    catsStep: 1,
    loadingLock: 0,
    pageLoadingLock: false,
  },

  /**
   * 生命周期函数--监听页面加载
   */
  onLoad: async function (options) {
    // 从缓存里读取options
    var fcampus = options.fcampus;
    if (!fcampus) {
      fcampus = this.getFCampusCache();
    }
    // 从分享点进来，到跳转到其他页面
    if (options.toPath) {
      wx.navigateTo({
        url: decodeURIComponent(options.toPath),
      });
    }
    // 从扫描二维码扫进来，目前只用于猫猫二维码跳转
    if (options.scene) {
      const scene = decodeURIComponent(options.scene);
      console.log("scene:", scene);
      if (scene.startsWith('toC=')) {
        const cat_No = scene.substr(4);
        const db = await cloud.databaseAsync();
        var cat_res = await db.collection('cat').where({
          _no: cat_No
        }).field({
          _no: true
        }).get()

        if (!cat_res.data.length) {
          return;
        }
        const _id = cat_res.data[0]._id;
        this.clickCatCard(_id, true);
      }
    }

    // 开始加载页面，获取设置
    var settings = null, retrySettings = 3;
    while (retrySettings > 0) {
      try {
        settings = await getGlobalSettings('genealogy', {nocache: true});
        break;
      } catch {
        console.error("get settings error 'genealogy'");
        await sleep(1000);
      }
    }
    
    if (!settings) {
      console.log("no setting");
      wx.showModal({
        title: '网络小故障',
        content: '请重新进入小程序',
        showCancel: false,
        success () {
          const pagesStack = getCurrentPages();
          const path = getCurrentPath(pagesStack);
          wx.restartMiniProgram({
            path
          });
        }
      })
      return
    }
    // 先把设置拿到
    this.jsData.catsStep = settings['catsStep'] || 1;
    // 启动加载
    await Promise.all([
      this.loadRecognize(),
      this.loadFilters(fcampus),
    ]);

    this.setData({
      main_lower_threshold: settings['main_lower_threshold'],
      adStep: settings['adStep'],
      photoPopWeight: settings['photoPopWeight'] || 10
    });

    // 载入公告信息
    this.newsModal = this.selectComponent("#newsModal");
    await this.loadNews();

    // 设置广告ID
    const ads = await getGlobalSettings('ads') || {};
    this.setData({
      ad: {
        banner: ads.genealogy_banner
      },
    })
  },

  onShow: function () {
    showTab(this);
  },

  loadRecognize: async function () {
    var settings = await getGlobalSettings(__wxConfig.envVersion === 'release' ? 'recognize' : 'recognize_test');
    this.setData({
      showRecognize: settings.interfaceURL && !settings.interfaceURL.includes("https://your.domain.com")
    })
  },

  loadFilters: async function (fcampus) {
    // 下面开始加载filters
    var res = await loadFilter();
    if (!res) {
      wx.showModal({
        title: '出错了...',
        content: '请到关于页，清理缓存后重启试试~',
        showCancel: false,
      });
      return false;
    }
    var filters = [];
    var area_item = {
      key: 'area',
      cateKey: 'campus',
      name: '校区',
      category: []
    };
    area_item.category.push({
      name: '全部校区',
      items: [], // '全部校区'特殊处理
      all_active: true
    });
    // 用个object当作字典，把area分下类
    var classifier = {};
    for (let i = 0, len = res.campuses.length; i < len; ++i) {
      classifier[res.campuses[i]] = {
        name: res.campuses[i],
        items: [], // 记录属于这个校区的area
        all_active: false
      };
    }
    for (let k = 0, len = res.area.length; k < len; ++k) {
      classifier[res.area[k].campus].items.push(res.area[k]);
    }
    for (let i = 0, len = res.campuses.length; i < len; ++i) {
      area_item.category.push(classifier[res.campuses[i]]);
    }
    // 把初始fcampus写入，例如"011000"
    if (fcampus && fcampus.length === area_item.category.length) {
      console.log("fcampus exist", fcampus, area_item);
      for (let i = 0; i < fcampus.length; i++) {
        const active = fcampus[i] == "1";
        area_item.category[i].all_active = active;
      }
    }
    filters.push(area_item);

    var colour_item = {
      key: 'colour',
      name: '花色',
      category: [{
        name: '全部花色',
        items: res.colour.map(name => {
          return {
            name: name
          };
        }),
        all_active: true
      }]
    }
    filters.push(colour_item);

    // 状态筛选大类
    var status_item = {
      key: 'status',
      name: '状态',
      category: []
    };

    // 添加全部状态选项
    status_item.category.push({
      name: '全部状态',
      items: [],
      all_active: true
    });

    // 领养状态选项
    var adopt_status = config.cat_status_adopt.map((name, i) => {
      return {
        name: name,
        value: i, // 数据库里存的
      };
    });
    
    var adopt_category = {
      name: '领养状态',
      key: 'adopt',
      items: adopt_status,
      all_active: false
    };

    // 绝育状态选项
    var neutered_category = {
      name: '绝育状态',
      key: 'sterilized',
      items: [
        { name: "已绝育", value: true },
        { name: "待绝育", value: false }
      ],
      all_active: false
    };

    // 其他状态选项（合并失踪和去往喵星）
    var other_category = {
      name: '其他',
      key: 'other',
      items: [
        { name: "未失踪", field: "missing", value: false },
        { name: "已失踪", field: "missing", value: true },
        { name: "去往喵星", field: "to_star", value: true }
      ],
      all_active: false
    };

    // 添加各种状态子类别
    status_item.category.push(adopt_category);
    status_item.category.push(neutered_category);
    status_item.category.push(other_category);

    // 添加状态大类到筛选器
    filters.push(status_item);

    // 激活默认筛选器
    filters[0].active = true;  // 校区
    console.log(filters);
    this.newUserTip();
    this.setData({
      filters: filters,
    });
    await this.reloadCats();
  },

  /**
   * 生命周期函数--监听页面初次渲染完成
   */
  onReady: function () {
    this.getHeights();
  },

  /**
   * 页面上拉触底事件的处理函数
   */
  onReachBottom: async function () {
    await this.loadMoreCats();
  },

  /**
   * 用户点击右上角分享
   */
  onShareAppMessage: function () {
    // 分享是保留校区外显filter
    const pagesStack = getCurrentPages();
    const path = getCurrentPath(pagesStack);
    const fcampus = this.getFCampusStr();
    const query = `${path}fcampus=${fcampus}`;
    console.log(query);
    return {
      title: share_text,
      path: query
    };
  },

  // 获取二进制的campus filter字符串
  getFCampusStr: function () {
    var fcampus = [];
    for (var item of this.data.filters[0].category) {
      fcampus.push(item.all_active ? "1" : "0");
    }
    return fcampus.join("");
  },

  onShareTimeline: function () {
    return {
      title: share_text,
      // query: 'cat_id=' + this.data.cat._id
    }
  },

  checkNeedLoad() {
    if (this.data.cats.length >= this.data.catsMax) {
      this.setData({
        loadnomore: true
      });
      this.jsData.pageLoadingLock = false;
      return false;
    }
    return true;
  },

  async reloadCats() {
    // 增加lock
    this.jsData.loadingLock++;
    const nowLoadingLock = this.jsData.loadingLock;
    const db = await cloud.databaseAsync();
    const cat = db.collection('cat');
    const query = await this.fGet();
    const cat_count = (await cat.where(query).count()).total;

    if (this.jsData.loadingLock != nowLoadingLock) {
      // 说明过期了
      return false;
    }
    this.setData({
      cats: [],
      catsMax: cat_count,
      loadnomore: false,
      filters_empty: Object.keys(query).length === 0,
    });
    await Promise.all([
      this.loadMoreCats(),
      // 加载待领养
      this.countWaitingAdopt(),
      // 刷新cache一下
      this.setFCampusCache()
    ]);

    this.unlockBtn();
  },

  // 加载更多的猫猫
  async loadMoreCats() {
    // 加载lock
    const nowLoadingLock = this.jsData.loadingLock;
    if (!this.checkNeedLoad() || this.data.loading) {
      return false;
    }

    await this.setData({
      loading: true,
    });

    var cats = this.data.cats;
    var step = this.jsData.catsStep;
    const db = await cloud.databaseAsync();
    const cat = db.collection('cat');
    const _ = db.command;
    const query = await this.fGet();
    var new_cats = (await cat.where(query).orderBy('mphoto', 'desc').orderBy('popularity', 'desc').skip(cats.length).limit(step).get()).data
    new_cats = shuffle(new_cats);

    if (this.jsData.loadingLock != nowLoadingLock) {
      // 说明过期了
      console.log(`过期了 ${this.jsData.loadingLock}, ${nowLoadingLock}`)
      return false;
    }
    console.log(new_cats);
    for (var d of new_cats) {
      d.photo = default_png;
      d.characteristics_string = [(d.colour || '') + ''].concat(d.characteristics || []).join('，');
      if (!d.mphoto) {
        d.mphoto_new = false;
        continue;
      }

      const today = new Date();
      const modified_date = new Date(d.mphoto);
      const delta_date = today - modified_date; // milliseconds

      // 小于7天
      d.mphoto_new = ((delta_date / 1000 / 3600 / 24) < 7);

      // 是否最近看过了
      const visit_date = getVisitedDate(d._id);
      if (visit_date >= modified_date) {
        d.mphoto_new = false;
      }
    }
    new_cats = cats.concat(new_cats);
    await this.setData({
      cats: new_cats,
      loading: false,
      loadnomore: Boolean(new_cats.length === this.data.catsMax)
    });
    await this.loadCatsPhoto();
  },

  async loadCatsPhoto() {
    // 加载lock
    const nowLoadingLock = this.jsData.loadingLock;

    const cats = this.data.cats;

    var cat2photos = {};
    var cat2commentCount = {};
    for (var cat of cats) {
      if (cat.photo === default_png) {
        cat2photos[cat._id] = await getAvatar(cat._id, cat.photo_count_best);
        if (!cat2photos[cat._id]) {
          continue;
        }
        if (!cat2photos[cat._id].userInfo) {
          cat2photos[cat._id].userInfo = (await getUserInfo(cat2photos[cat._id]._openid)).userInfo;
        }
        cat2commentCount[cat._id] = await getCatCommentCount(cat._id);
      }
    }

    if (this.jsData.loadingLock != nowLoadingLock) {
      console.log("过期了，照片数量：" + cats.length);
      // 说明过期了
      return false;
    }

    // 这里重新获取一遍，因为可能已经刷新了
    var new_cats = this.data.cats;
    for (var c of new_cats) {
      if (cat2photos[c._id]) {
        c.photo = cat2photos[c._id];
        c.comment_count = cat2commentCount[c._id];
      }
    }

    await this.setData({
      cats: new_cats
    });
  },

  bindImageLoaded(e) {
    const idx = e.currentTarget.dataset.index;
    this.setData({
      [`cats[${idx}].imageLoaded`]: true
    });
  },

  // 点击识猫按钮
  clickRecognize(e) {
    wx.navigateTo({
      url: '/pages/packageA/pages/recognize/recognize',
    });
  },

  // 点击猫猫卡片
  clickCatCard(e, isCatId) {
    const cat_id = isCatId ? e : e.currentTarget.dataset.cat_id;
    const index = this.data.cats.findIndex(cat => cat._id == cat_id);
    const detail_url = '/pages/genealogy/detailCat/detailCat';

    if (index != -1) {
      this.setData({
        [`cats[${index}].mphoto_new`]: false
      });
    }

    wx.navigateTo({
      url: detail_url + '?cat_id=' + cat_id,
    });
  },

  // 开始计算各个东西高度
  getHeights() {
    wx.getSystemInfo({
      success: res => {
        // console.log(res);
        this.setData({
          "heights.filters": res.screenHeight * 0.065,
          "heights.screenHeight": res.screenHeight,
          "heights.windowHeight": res.windowHeight,
          "heights.statusBarHeight": res.statusBarHeight,
          "heights.rpx2px": res.windowWidth / 750,
        });
      }
    });
  },
  // 管理员判断，其实可以存到global里
  async bindManageCat(e) {
    var res = await isManagerAsync();
    if (res) {
      const cat_id = e.currentTarget.dataset.cat_id;
      wx.navigateTo({
        url: '/pages/manage/catManage/catManage?cat_id=' + cat_id + '&activeTab=info',
      });
      return;
    }
    console.log("not a manager");
  },

  ////// 下面开始新的filter //////
  // mask滑动事件catch
  voidMove: function () { },
  // toggle filters
  fToggle: function () {
    // 这里只管显示和隐藏，类似取消键的功能
    this.setData({
      filters_show: !this.data.filters_show
    });
  },
  fShow: function () {
    // 这里只管显示和隐藏，类似取消键的功能
    this.setData({
      filters_show: true
    });
  },
  fHide: function () {
    // 这里只管显示和隐藏，类似取消键的功能
    this.setData({
      filters_show: false
    });
  },
  // 点击main filter，切换sub的
  fClickMain: function (e) {
    var filters = this.data.filters;
    const click_idx = e.currentTarget.dataset.index;

    for (var item of filters) {
      item.active = false;
    }
    filters[click_idx].active = true;

    this.setData({
      filters: filters,
      filters_sub: click_idx
    });
  },
  // 点击category filter，全选/反选该类下所有sub
  fClickCategory: async function (e, singleChoose) {
    console.log(e);
    var filters = this.data.filters;
    var {index, filters_sub} = e.target.dataset;
    if (filters_sub == undefined) {
      filters_sub = this.data.filters_sub;
    }

    const all_active = !filters[filters_sub].category[index].all_active;
    var category = filters[filters_sub].category[index];
    if (index == 0 || singleChoose) { // 默认第0个是'全部'
      for (let i = 0, len = filters[filters_sub].category.length; i < len; ++i) { // 把所有项反激活
        var ctg = filters[filters_sub].category[i];
        ctg.all_active = false;
        for (let k = 0, length = ctg.items.length; k < length; ++k) {
          ctg.items[k].active = false;
        }
      }
      filters[filters_sub].category[index].all_active = all_active; // '全部'的激活状态
    } else {
      filters[filters_sub].category[0].all_active = false; // 取消'全部'的激活，默认第0个是'全部'
      category.all_active = all_active; // 点击的category状态取反
      for (let k = 0, len = category.items.length; k < len; ++k) { // 反激活其下所有sub
        category.items[k].active = false;
      }
    }
    const fLegal = this.fCheckLegal(filters);
    this.setData({
      filters: filters,
      filters_legal: fLegal
    });
  },
  // 点击sub filter，切换激活项
  fClickSub: function (e) {
    var filters = this.data.filters;
    var filters_sub = this.data.filters_sub;

    const category = filters[filters_sub].category[e.target.dataset.index];
    const index = e.target.dataset.innerindex;

    category.items[index].active = !category.items[index].active; // 激活状态取反
    filters[filters_sub].category[0].all_active = false; // 取消'全部'的激活，默认第0个是'全部'
    category.all_active = false; // 直接反激活category

    const fLegal = this.fCheckLegal(filters);
    this.setData({
      filters: filters,
      filters_legal: fLegal
    });
  },
  // 检查现在这个filter是否有效，如果没有，那就deactive完成键
  fCheckLegal: function (filters) {
    for (const mainF of filters) {
      var count = 0; // 激活的数量
      if (mainF.category[0].all_active) continue; // '全部'是激活的
      for (const category of mainF.category) {
        if (category.all_active) {
          count += category.items.length;
          continue;
        }
        for (const item of category.items) {
          if (item.active) ++count;
        }
      }
      if (count == 0) return false;
    }
    return true;
  },

  // 构建状态查询条件
  _buildStatusQuery: function (statusFilter, _) {
    const conditions = [];
    if (statusFilter.category[0].all_active) { // 选择了'全部状态'
      return conditions;
    }

    for (const category of statusFilter.category) {
      if (category.name === '全部状态') continue;

      const fieldKey = category.key;
      const isAllCategoryActive = category.all_active;
      let selectedValues = [];
      let specificConditions = []; // 用于存储 _.or 等复杂条件

      if (!isAllCategoryActive) {
          selectedValues = category.items
             .filter(item => item.active)
             .map(item => ({ field: item.field, value: item.value })); // 存储 field 和 value
      } else {
        // 如果整个分类激活，根据 key 特殊处理
        if (fieldKey === 'other') {
            category.items.forEach(item => {
                const field = item.field;
                const value = item.value;
                // 特殊处理 other 分类下的未失踪和已失踪
                if (field === 'missing') {
                    if (value === false) {
                        // 未失踪包含 false 和不存在
                        specificConditions.push(_.or([{ [field]: false }, { [field]: _.exists(false) }]));
                    } else {
                        specificConditions.push({ [field]: value });
                    }
                } else {
                     specificConditions.push({ [field]: value });
                }
            });
           // 'other' 类别特殊，直接添加到主 conditions
           // 注意：这里需要用 OR 连接 other 内部的条件
           if (specificConditions.length > 0) {
               conditions.push(_.or(specificConditions));
           }
           continue; // 处理完 other，继续下一个 category
        } else if (fieldKey !== 'sterilized' && fieldKey !== 'adopt') {
          // 非特殊处理的，选中类别等于选中所有子项
           selectedValues = category.items.map(item => ({ field: item.field, value: item.value })); // 存储 field 和 value
        }
        // 对于 sterilized 和 adopt，选中整个类别表示不筛选该项
      }

      // 处理非 other 类别的选中项
      if (fieldKey !== 'other' && selectedValues.length > 0) {
          if (fieldKey === 'sterilized') {
             // 绝育: 待绝育(false) 包含 exists(false)
             const hasFalse = selectedValues.some(item => item.value === false);
             const hasTrue = selectedValues.some(item => item.value === true);
             if (!isAllCategoryActive) { // 仅当未全选分类时处理
                 if (hasFalse && !hasTrue) {
                    specificConditions.push(_.or([{ [fieldKey]: false }, { [fieldKey]: _.exists(false) }]));
                 } else if (hasTrue && !hasFalse) {
                    specificConditions.push({ [fieldKey]: true });
                 }
                 // else (both true and false selected) -> no condition added
             }
         } else if (fieldKey === 'adopt') {
             // 领养: 未领养(0) 包含 exists(false)
             const unadoptedValue = 0;
             const hasUnadopted = selectedValues.some(item => item.value === unadoptedValue);
             const otherSelectedValues = selectedValues.filter(item => item.value !== unadoptedValue).map(item => item.value);

             if (!isAllCategoryActive) { // 仅当未全选分类时处理
                 if (hasUnadopted) {
                    const orConditions = [{ [fieldKey]: unadoptedValue }, { [fieldKey]: _.exists(false) }];
                    if (otherSelectedValues.length > 0) {
                       orConditions.push({ [fieldKey]: _.in(otherSelectedValues) });
                    }
                    specificConditions.push(_.or(orConditions));
                 } else if (otherSelectedValues.length > 0) {
                    specificConditions.push({ [fieldKey]: _.in(otherSelectedValues) });
                 }
             }
         } else { // 其他普通状态字段
            const values = selectedValues.map(item => item.value);
            if (values.length > 0) {
               specificConditions.push({ [fieldKey]: _.in(values) });
            }
         }

         if (specificConditions.length > 0) {
             // 如果产生了多个 specificConditions (理论上大部分情况只有一个)
             // 如果只有一个，直接 push 对象；多个则用 and 连接 (虽然目前逻辑不会产生多个)
             if (specificConditions.length === 1) {
                 conditions.push(specificConditions[0]);
             } else {
                 conditions.push(_.and(specificConditions)); // 保留以防万一
             }
         }
      }
      // 处理 other 分类下单个选中项的情况
      else if (fieldKey === 'other' && selectedValues.length > 0) {
          selectedValues.forEach(item => {
              const field = item.field;
              const value = item.value;
              if (field === 'missing' && value === false) {
                  specificConditions.push(_.or([{ [field]: false }, { [field]: _.exists(false) }]));
              } else {
                  specificConditions.push({ [field]: value });
              }
          });
          if (specificConditions.length > 0) {
              conditions.push(_.or(specificConditions));
          }
      }

    }
    // 对于 status 内部不同 category 的条件，它们之间应该是 OR 关系
    // 但目前的 UI 设计和代码逻辑是 AND 关系 (例如选了'待领养' AND '已绝育')
    // 所以直接返回 conditions 数组，由外层统一 and
    return conditions;
  },
  
  fGet: async function () {
    const db = await cloud.databaseAsync();
    const _ = db.command;
    const filters = this.data.filters;
    var res = []; // 存储最终 AND 条件

    for (const mainF of filters) {
      const key = mainF.key;

      if (key === 'status') {
        const statusConditions = this._buildStatusQuery(mainF, _);
        if (statusConditions.length > 0) {
          res.push(...statusConditions); // 将状态条件添加到主条件列表
        }
        continue; // 处理完 status，跳到下一个主筛选器
      }

      // --- 处理非 status 的筛选器 ---
      if (mainF.category[0].all_active) continue; // 选择了'全部', 跳过

      var selected = []; // 储存已经选中的项
      const cateFilter = Boolean(mainF.cateKey);
      let cateKey = '';
      let cateSelected = [];
      if (cateFilter) {
          cateKey = mainF.cateKey;
      }

      for (const category of mainF.category) {
        if (category.name === mainF.category[0].name) continue; // 跳过'全部xx'分类本身

        let cateKeyPushed = false;
        const isAllCategoryActive = category.all_active;

        for (const item of category.items) {
          if (isAllCategoryActive || item.active) {
            let choice = item.value !== undefined ? item.value : item.name;
            if (item.value === null) {
               choice = _.exists(false); // 处理字段不存在的情况
            }
            // 对于 _.exists(false) 的情况，不能直接 push 到 selected 数组给 _.in 使用
            if (typeof choice === 'object' && choice._internalType === 'exists') {
                res.push({[key]: choice}); // 直接添加到主条件
            } else {
                selected.push(choice);
            }

            if (cateFilter && !cateKeyPushed && category.name) { // 确保 category.name 存在
              cateSelected.push(category.name);
              cateKeyPushed = true;
            }
          }
        }
      }

      // console.log(key, selected);
      if (selected.length > 0) {
         res.push({ [key]: _.in(selected) });
      }
      if (cateFilter && cateSelected.length > 0) {
         res.push({ [cateKey]: _.in(cateSelected) });
      }
    }
    // --- 处理非 status 的筛选器结束 ---

    this.setData({
      filters_active: res.length > 0 || this.data.filters_input.length > 0
    });

    // 处理文字搜索
    const filters_input = regReplace(this.data.filters_input);
    if (filters_input.length) {
      var search_str = '';
      // 构建 (.*word1.*)|(.*word2.*) 形式的正则
      for (const n of filters_input.trim().split(' ')) {
        if (n) { // 避免空字符串
          const escaped_n = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // 转义正则特殊字符
          search_str += (search_str ? '|' : '') + `(.*${escaped_n}.*)`;
        }
      }

      if (search_str) { // 确保搜索字符串不为空
         let regexp = db.RegExp({
             regexp: search_str,
             options: 'i', // 使用 'i' 进行不区分大小写搜索 ('is' 中的 's' 通常指 dotall，这里不需要)
         });
         res.push(_.or([{
           name: regexp
         }, {
           nickname: regexp
         }]));
      }
    }

    // console.log("Final Query:", res);
    return res.length ? _.and(res) : {};
  },
  fComfirm: function (e) {
    if (!this.data.filters_legal) {
      return false;
    }

    this.lockBtn();

    this.reloadCats();
    this.fHide();
    this.unlockBtn();
  },
  fReset: async function () {
    // 重置所有分类
    var filters = this.data.filters;
    // const filters_sub = this.data.filters_sub;
    for (let sub = 0, len = filters.length; sub < len; ++sub) {
      for (let i = 0, catelen = filters[sub].category.length; i < catelen; ++i) {
        var category = filters[sub].category[i];
        category.all_active = false;
        for (let k = 0, itemlen = category.items.length; k < itemlen; ++k) {
          category.items[k].active = false;
        }
      }
      filters[sub].category[0].all_active = true; // 默认第0个是'全部'
    }

    const fLegal = this.fCheckLegal(filters);
    await this.setData({
      filters: filters,
      filters_legal: fLegal
    });

    // 确认过滤器并关闭展板
    await this.fComfirm();
  },
  // 点击外显的校区
  fClickCampus: async function (e) {
    if (this.jsData.pageLoadingLock) {
      console.log("Page is locked");
      return false;
    }
    await this.fClickCategory(e, true);
    await this.fComfirm();
  },
  // 发起文字搜索
  fSearchInput: function (e) {
    const value = e.detail.value;
    this.setData({
      filters_input: value
    });
  },
  fSearch: function (e) {
    this.reloadCats();
  },
  fSearchClear: async function () {
    await this.setData({
      filters_input: ""
    });
    this.fSearch();
  },
  // 搜索框是否要显示阴影
  fScroll: function (e) {
    const scrollTop = e.detail.scrollTop;
    const filters_show_shadow = this.data.filters_show_shadow;
    if ((scrollTop < 50 && filters_show_shadow == true) || (scrollTop >= 50 && filters_show_shadow == false)) {
      this.setData({
        filters_show_shadow: !filters_show_shadow
      });
    }
  },

  ////// 广告相关
  changeState(ad_id, show) {
    var ad_show = this.data.ad_show;
    if (ad_show[ad_id] != show) {
      ad_show[ad_id] = show;
      this.setData({
        ad_show: ad_show
      });
    }
  },

  // 广告加载成功，展示出来
  adLoad(e) {
    const ad_id = e.currentTarget.dataset.ad_id;
    console.log('广告加载成功', ad_id);
    this.changeState(ad_id, true);
  },
  // 加载失败
  adError(e) {
    const ad_id = e.currentTarget.dataset.ad_id;
    console.log('广告加载失败', ad_id);
    this.changeState(ad_id, false);
  },
  // 被关闭
  adClose(e) {
    const ad_id = e.currentTarget.dataset.ad_id;
    console.log('广告被关闭', ad_id);
    this.changeState(ad_id, false);
  },

  // 查找有多少只猫待领养
  countWaitingAdopt: async function () {
    const target = config.cat_status_adopt_target;
    const value = config.cat_status_adopt.findIndex((x) => {
      return x === target
    });

    const db = await cloud.databaseAsync();
    const cat = db.collection('cat');
    const query = {
      adopt: value
    };

    this.setData({
      adopt_count: (await cat.where(query).count()).total
    });
  },

  // 点击领养按钮
  clickAdoptBtn: async function (e) {
    if (this.jsData.pageLoadingLock) {
      console.log("[点击领养按钮] Page is locking");
      return false;
    }
    this.lockBtn();

    var filters = this.data.filters;
    // 找到状态大类
    var statusIndex = filters.findIndex(x => x.key === "status");
    // 找到领养状态子类
    var adoptCategory = filters[statusIndex].category.find(x => x.key === "adopt");
    
    const target_status = config.cat_status_adopt_target;
    const target_index = config.cat_status_adopt.findIndex(x => x === target_status);
    
    // 找到对应的选项
    const itemIndex = adoptCategory.items.findIndex(x => x.value === target_index);
    
    if (adoptCategory.items[itemIndex].active) {
      // 已经激活了
      this.unlockBtn();
      return false;
    }

    // 取消全部状态
    filters[statusIndex].category[0].all_active = false;
    
    // 激活领养状态类别，但不激活子标签
    adoptCategory.all_active = true;
    
    // 取消所有子标签的激活状态
    for (let i = 0; i < adoptCategory.items.length; i++) {
      adoptCategory.items[i].active = false;
    }

    const fLegal = this.fCheckLegal(filters);
    this.setData({
      filters: filters,
      filters_legal: fLegal
    });

    await Promise.all([
      this.reloadCats(),
      this.showFilterTip()
    ])
    this.unlockBtn();
  },

  // 显示过滤器的提示
  async showFilterTip() {
    await this.setData({
      show_filter_tip: true
    });
    await sleep(6000);
    await this.setData({
      show_filter_tip: false
    });
  },

  newUserTip() {
    const key = "newUserTip";
    var lastTime = wx.getStorageSync(key);

    if (lastTime != undefined && getDeltaHours(lastTime) < tipInterval) {
      // 刚提示没多久
      return false;
    }

    // 显示提示
    this.showFilterTip();

    // 写入时间
    wx.setStorageSync(key, new Date());
  },

  // 返回首页
  async clickBackFirstPageBtn() {
    if (this.jsData.pageLoadingLock) {
      console.log("[返回首页] page is locked");
      return false;
    }

    this.lockBtn();

    await this.fReset();
    await this.fSearchClear();
    this.unlockBtn();
  },

  async loadNews() {
    if (!await checkCanShowNews()) {
      return;
    }
    // 载入需要弹窗的公告
    const db = await cloud.databaseAsync();
    var newsList = (await db.collection('news').orderBy('date', 'desc').where({
      setNewsModal: true
    }).get()).data

    this.setData({
      newsList: newsList,
    });
    console.log("公告弹出模块: ", this.data.newsList);
    if (newsList.length == 0) {
      return;
    }

    if (newsList[0].coverPath) {
      this.setData({
        newsImage: newsList[0].coverPath
      })
    } else if (newsList[0].photosPath.length != 0) {
      this.setData({
        newsImage: newsList[0].photosPath[0]
      })
    }
    if (!this.checkNewsVisited()) {
      this.newsModal.showNewsModal();
    }
  },

  // 取消事件
  _cancelEvent() {
    this.newsModal.hideNewsModal();
    this.setNewsVisited();
  },
  // 确认事件: 查看公告详情
  _confirmEvent() {
    this.newsModal.hideNewsModal();
    this.setNewsVisited();
    const news_id = this.data.newsList[0]._id;
    const detail_url = '/pages/news/detailNews/detailNews';
    wx.navigateTo({
      url: detail_url + '?news_id=' + news_id,
    });
  },
  // 检测公告是否已读
  checkNewsVisited() {
    const news_id = this.data.newsList[0]._id;
    var key = `visit-news-${news_id}`;
    var visited = cache.getCacheItem(key);
    // console.log(visited);
    return visited;
  },
  // 设置已读时间
  setNewsVisited() {
    const news_id = this.data.newsList[0]._id;
    var key = `visit-news-${news_id}`;
    cache.setCacheItem(key, true, cache.cacheTime.genealogyNews);
  },

  // 上锁
  lockBtn() {
    // console.log("lock");
    this.jsData.pageLoadingLock = true;
  },
  // 解锁
  unlockBtn() {
    // console.log("unlock");
    this.jsData.pageLoadingLock = false;
  },

  // campus过滤器cache起来
  setFCampusCache: function () {
    const fc = this.getFCampusStr();
    cache.setCacheItem("genealogy-fcampus", fc, cache.cacheTime.genealogyFCampus);
  },

  // campus过滤器取cache
  getFCampusCache: function () {
    return cache.getCacheItem("genealogy-fcampus");
  }
})