import { text as text_cfg, feedback_wj_img } from "../../../config";
import {
  cloud
} from "../../../cloudAccess";
const share_text = text_cfg.app_name + ' - ' + text_cfg.feedback.share_tip;

Page({

  /**
   * 页面的初始数据
   */
  data: {
    text_cfg: text_cfg,
  },

  toMyFeedback() {
    wx.navigateTo({
      url: '/pages/info/feedback/myFeedback/myFeedback'
    });
  },

  toFeedback() {
    wx.navigateTo({
      url: '/pages/genealogy/feedbackDetail/feedbackDetail',
    })
  },

  async toNewCat() {
    wx.openEmbeddedMiniProgram({
      // 要跳转的小程序的appid
      appId: 'wxebadf544ddae62cb',
      path: 'pages/survey/index?sid=9293049&hash=b144&navigateBackMiniProgram=true',
    })
  },

  /**
   * 用户点击右上角分享
   */
  onShareAppMessage: function () {
    return {
      title: share_text
    }
  }
})