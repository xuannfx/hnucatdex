import { cloud } from "../../../utils/cloudAccess";
import { text as text_cfg } from "../../../config";

Page({
  data: {
    stats: {},
    loading: true,
    text_cfg: text_cfg,
    showUnknownCatsPopup: false,
    showEventsPopup: false,
  },

  onLoad: function () {
    this.loadStats();
  },

  onPullDownRefresh: function() {
    this.loadStats().then(() => {
      wx.stopPullDownRefresh();
    });
  },

  // 加载统计数据
  async loadStats() {
    this.setData({ loading: true });
    
    try {
      const res = await cloud.callFunction({
        name: 'getCatStats',
      });
      
      if (res.result && res.result.success) {
        const stats = res.result.data;
        
        this.setData({
          stats,
          loading: false
        });
        console.log("统计数据:", stats);
      } else {
        wx.showToast({
          title: '获取数据失败',
          icon: 'error'
        });
        this.setData({ loading: false });
      }
    } catch (error) {
      console.error("获取统计数据错误:", error);
      wx.showToast({
        title: '获取数据失败',
        icon: 'error'
      });
      this.setData({ loading: false });
    }
  },

  // 处理点击刷新按钮
  handleRefresh() {
    this.loadStats();
  },

  showUnknownCatsPopup() {
    this.setData({
      showUnknownCatsPopup: true
    });
  },

  closeUnknownCatsPopup() {
    this.setData({
      showUnknownCatsPopup: false
    });
  },

  showEventsPopup() {
    if (this.data.stats.latestEvents && this.data.stats.latestEvents.length > 0) {
      this.setData({ showEventsPopup: true });
    } else {
      wx.showToast({
        title: '暂无事件记录',
        icon: 'none'
      });
    }
  },

  closeEventsPopup() {
    this.setData({ showEventsPopup: false });
  },

  // 分享
  onShareAppMessage: function () {
    return {
      title: `${text_cfg.app_name} - 数据看板`
    }
  },

  onShareTimeline: function () {
    return {
      title: `${text_cfg.app_name} - 数据看板`,
    }
  }
}); 