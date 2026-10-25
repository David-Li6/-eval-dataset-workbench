export const generationFields = ['Question', 'User Question', 'SELECT Data', 'answer', 'Scoring criteria', 'difficulty', 'Task family', 'source'];
export const automaticVariables = ['参考资料', '源文档', '文件内容', '题目数量', '总题目数量'];
export const defaultGenerationPrompt = `请根据参考资料构建 SFT 后的模型评测集。本次共需 {{总题目数量}} 道题，当前批次生成 {{题目数量}} 道。
优先依据原题、已有参考答案、专家结论/意见、口径落点提示及暴露的模型侧问题，引用、改写和延展问题，覆盖不同难度和任务族。
Question 为完整、自包含的评测题面；User Question 为真实用户会直接问的简短自然问题，不把答案要求都写进用户问题。
SELECT Data 放模型回答时需要的报价记录、查询结果或计算数据，不需要数据时为 null。回答模型不接外部工具，所需事实和数据必须自包含；模拟数据必须明确说明。
answer 给出符合专家期望的参考答案；Scoring criteria 给出可执行的评分标准，默认满分 5 分，明确分项、分值、判定条件和重大错误封顶规则。
difficulty、Task family 尽量沿用原文档口径。source 保留原题 ID（如有），并包含参考资料给出的 SRC-xxxx 引用编号，确保能追溯到原文件位置。
只使用提供的资料，不编造实时行情、数据来源或专家意见。使用自定义模拟数据时写明其为模拟数据。不要重复已有问题。

参考资料：
{{参考资料}}`;
