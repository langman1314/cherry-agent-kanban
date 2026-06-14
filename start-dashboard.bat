@echo off
:: Agent Dashboard - PM2 自启动脚本
:: 放在 Windows 启动文件夹中即可开机自启
cd /d "D:\Desktop\cherryAi_texty\控制面板制作\agent-dashboard"
pm2 resurrect 2>nul || pm2 start server.js --name "agent-dashboard" --watch