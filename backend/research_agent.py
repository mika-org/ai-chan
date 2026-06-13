import httpx
import logging
import asyncio
from bs4 import BeautifulSoup
from typing import List, Dict
import re

logger = logging.getLogger("ai-chan-research")

SEARCH_API = "https://ddg-api.herokuapp.com/search"  # DuckDuckGo lightweight


async def _fetch_page_text(url: str) -> str:
    """Fetch and extract plain text from a URL."""
    try:
        async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
            headers = {"User-Agent": "Mozilla/5.0 (compatible; AiChanResearch/1.0)"}
            res = await client.get(url, headers=headers)
            soup = BeautifulSoup(res.text, "html.parser")
            # Remove scripts/styles
            for tag in soup(["script", "style", "nav", "footer", "header"]):
                tag.decompose()
            text = soup.get_text(separator="\n", strip=True)
            # Limit to first 2000 chars per page
            return text[:2000]
    except Exception as e:
        logger.warning(f"Failed to fetch {url}: {e}")
        return ""


async def search_and_summarize(query: str, llm_base_url: str, model: str, on_progress=None) -> str:
    """
    Deep Research agent: searches multiple sources, reads pages, and synthesizes a report.
    on_progress: async callback(step: str) for streaming status updates.
    """
    steps = []

    async def emit(msg: str):
        steps.append(msg)
        if on_progress:
            await on_progress(msg)

    await emit(f"🔎 Initiating search for: **{query}**")

    # 1. Search using DuckDuckGo Lite HTML (no API key needed)
    search_results = []
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            params = {"q": query, "kl": "wt-wt", "kp": "-2"}
            res = await client.get("https://lite.duckduckgo.com/lite/", params=params)
            soup = BeautifulSoup(res.text, "html.parser")
            # Extract result links and snippets
            links = soup.select("a.result-link")[:5]
            for a in links:
                href = a.get("href", "")
                title = a.get_text(strip=True)
                if href.startswith("http"):
                    search_results.append({"title": title, "url": href})

        await emit(f"📡 Found {len(search_results)} sources to analyze.")
    except Exception as e:
        await emit(f"⚠️ Search layer encountered an issue: {e}. Proceeding with LLM-only synthesis.")

    # 2. Fetch page content from each source
    source_texts = []
    for i, result in enumerate(search_results[:4]):
        await emit(f"📄 Reading source {i+1}/{len(search_results[:4])}: {result['title'][:60]}...")
        text = await _fetch_page_text(result["url"])
        if text:
            source_texts.append(f"--- SOURCE: {result['title']} ({result['url']}) ---\n{text}")

    await emit(f"🧠 Synthesizing {len(source_texts)} sources into a comprehensive report...")

    # 3. Send to LLM for synthesis
    combined = "\n\n".join(source_texts) if source_texts else "(No web sources available. Use your training knowledge.)"

    system_prompt = (
        "You are Ai-Chan, an advanced research intelligence. Your task is to synthesize a deep, "
        "comprehensive, and well-structured research report. Use markdown formatting with headers, "
        "bullet points, and a conclusions section. Be thorough and precise."
    )
    user_prompt = (
        f"Research Query: {query}\n\n"
        f"Web Sources Content:\n{combined}\n\n"
        "Please synthesize a comprehensive research report answering the query."
    )

    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            payload = {
                "model": model,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt}
                ],
                "max_tokens": 4096,
                "temperature": 0.4,
                "stream": False
            }
            res = await client.post(f"{llm_base_url}/v1/chat/completions", json=payload)
            if res.status_code == 200:
                data = res.json()
                report = data["choices"][0]["message"]["content"]
                await emit("✅ Research report synthesis complete.")
                return report
            else:
                await emit(f"⚠️ LLM synthesis failed (HTTP {res.status_code}).")
                return "Report generation failed. Please check LLM connection."
    except Exception as e:
        await emit(f"❌ Synthesis error: {e}")
        return f"Report generation failed: {e}"
