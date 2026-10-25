/* 推送版式的展示层；不参与内容选择、模板存储或同步 payload。 */
window.MpDraftThemeVisuals = (function() {
    'use strict';
    var serif = 'Songti SC,STSong,SimSun,serif';
    var sans = '-apple-system,BlinkMacSystemFont,PingFang SC,Microsoft YaHei,sans-serif';
    var editions = {
        'morning-edition': ['晨间阅读 · 玫瑰墨色', '#85435f', '#fff9fa', 'left', serif, 'double'],
        'club-noticeboard': ['社团消息 · 暖红布告', '#823f54', '#fffaf4', 'left', sans, 'dashed'],
        'library-bookmark': ['阅读摘录 · 松绿书签', '#365f5a', '#fffdf7', 'left', serif, 'solid'],
        'field-notes': ['校园日常 · 晴空蓝', '#256b96', '#f6fcff', 'center', sans, 'solid'],
        'evening-journal': ['晚间随笔 · 暖紫手账', '#59466f', '#fcfaff', 'left', serif, 'dashed'],
        'rainy-letter': ['写给同学 · 灰蓝信笺', '#415777', '#f5f8fc', 'left', serif, 'double'],
        'campus-lab': ['每周发现 · 青绿笔记', '#185a64', '#f8fffc', 'left', sans, 'solid'],
        'yearbook': ['校园回忆 · 胡桃相册', '#80553f', '#fffdf8', 'center', serif, 'double'],
        'cherry-mailbox': ['心事来信 · 樱花粉', '#984461', '#fff8fb', 'center', serif, 'dashed'],
        'blue-screening': ['光影故事 · 深海蓝', '#263b70', '#f5f8ff', 'center', sans, 'double'],
        'cream-zine': ['校园小刊 · 奶油焦糖', '#795237', '#fffaf0', 'left', serif, 'solid'],
        'blackboard-notes': ['课间记录 · 黑板绿', '#263d3a', '#f9fff9', 'left', sans, 'double'],
        'moon-radio': ['夜间来信 · 月光紫', '#443660', '#faf8ff', 'center', serif, 'solid']
    };

    function get(theme) {
        var edition = editions[theme.id] || editions['morning-edition'];
        return {
            description: edition[0], accent: edition[1], paper: edition[2],
            align: edition[3], font: edition[4], rule: edition[5],
            ink: theme.weatherText, muted: theme.weatherMuted,
            soft: theme.weatherMutedCard, border: theme.weatherBorder,
            surface: theme.weatherCard, secondary: theme.weatherAccent
        };
    }

    function header(theme, dateInfo, escapeHtml) {
        var v = get(theme);
        return '<section style="padding:30px 24px 26px;background:' + v.paper + ';color:' + v.ink + ';text-align:' + v.align + ';border-top:6px solid ' + v.accent + ';border-bottom:1px solid ' + v.border + ';">' +
            '<p style="margin:0 0 18px;font-size:12px;font-weight:600;color:' + v.accent + ';">校园墙 / ' + escapeHtml(theme.name) + '</p>' +
            '<h2 style="margin:0;font-family:' + v.font + ';font-size:28px;font-weight:700;line-height:1.5;letter-spacing:1px;color:' + v.ink + ';">今日校园精选</h2>' +
            '<p style="margin:20px 0 0;padding-top:12px;border-top:3px ' + v.rule + ' ' + v.border + ';font-size:12px;line-height:1.8;color:' + v.muted + ';">' + escapeHtml(dateInfo.date || '') + '　' + escapeHtml(dateInfo.week || '') + '</p></section>';
    }

    function swatch(theme) {
        var v = get(theme);
        return 'background:' + v.paper + ';--edition-accent:' + v.accent + ';--edition-border:' + v.border + ';';
    }

    return { get: get, header: header, swatch: swatch };
})();
