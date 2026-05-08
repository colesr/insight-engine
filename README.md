# Global Insight Engine

Docker Space for the Global Insight Engine — an interactive data exploration platform with 120+ development indicators, sentiment globe, and correlation analysis.

## Features
- Interactive 3D globe with real-time news sentiment
- Variable explorer with correlations, distributions, and network graphs
- Scenario simulator, country comparison, priority ranking
- Natural Earth coastline overlay on the sentiment globe

## Deploy
```bash
docker build -t insight-engine .
docker run -p 7860:7860 insight-engine
```
